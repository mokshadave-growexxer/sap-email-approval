// Restart-durable memory of which approved drafts have already been posted,
// and which ones failed and must NOT be posted again.
//
// WHY A FILE: the previous guard was an in-process Set that only recorded
// successes, so every restart forgot every failure and the 30s poll resumed
// burning DocEntry. This state has to outlive the process. Everything else the
// app persists lives in SAP UDTs, which need a manual UDT/UDF creation per
// company; a local JSON file needs no SAP change and is enough for what this
// holds (operational retry bookkeeping, not business data). The record shape is
// deliberately store-agnostic so it can move into a UDT later without touching
// the state machine in draftPostGuard.js.
//
// CONCURRENCY: one file per company key, so the two single-company processes
// (MILLP on :3000, MSPL on :3001) never touch the same file. Within a process
// every write is serialised through a promise chain and committed by
// write-temp-then-rename, so a crash mid-write cannot leave a torn file.

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config/index.js';
import logger from '../../config/logger.js';
import { istIso } from '../audit/decisionLogShared.js';

export const DRAFT_POST_STATE = Object.freeze({
  /** Converted to a Sales Order. Never post again. */
  POSTED: 'posted',
  /** Failed in a way retrying cannot fix. Never post again without a human. */
  PARKED: 'parked',
  /** Transient failure; eligible again at nextAttemptAt. */
  RETRYING: 'retrying',
  /** A post is in flight right now (claim). Blocks a concurrent second post. */
  POSTING: 'posting',
});

const STATE_VERSION = 1;
// A claim older than this is treated as abandoned (process died mid-post), so a
// crash can never wedge a draft in 'posting' forever.
const CLAIM_STALE_MS = 10 * 60 * 1000;
// Successful records are bookkeeping only — SAP itself is the source of truth
// (IsDraft flips to 'N'). Drop old ones so the file cannot grow without bound.
const POSTED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function draftKey(approvalRequestId, draftEntry) {
  return `${String(approvalRequestId ?? '')}:${String(draftEntry ?? '')}`;
}

function stateFilePath(companyKey) {
  const safe = String(companyKey ?? 'default').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(config.draftPost.stateDir, `draft-post-${safe}.json`);
}

/** In-memory cache of each company's file, plus its write queue. */
const caches = new Map();

function cacheFor(companyKey) {
  let entry = caches.get(companyKey);
  if (!entry) {
    entry = { data: null, writeChain: Promise.resolve() };
    caches.set(companyKey, entry);
  }
  return entry;
}

function emptyState(companyKey) {
  return { version: STATE_VERSION, companyKey, drafts: {} };
}

function prunePosted(state) {
  const cutoff = Date.now() - POSTED_RETENTION_MS;
  for (const [key, record] of Object.entries(state.drafts)) {
    if (record?.state !== DRAFT_POST_STATE.POSTED) continue;
    const at = Date.parse(record.postedAt ?? record.lastAttemptAt ?? '');
    if (Number.isFinite(at) && at < cutoff) {
      delete state.drafts[key];
    }
  }
  return state;
}

async function load(companyKey) {
  const entry = cacheFor(companyKey);
  if (entry.data) return entry.data;

  const file = stateFilePath(companyKey);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.drafts !== 'object') {
      throw new Error('malformed state file');
    }
    entry.data = prunePosted({ ...emptyState(companyKey), ...parsed });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // A corrupt or unreadable file must not be silently treated as "nothing
      // has ever failed" — that would re-open the burn. Keep the bad file for
      // inspection and start clean, loudly.
      logger.error('draftPostState: could not read state file; starting empty (previous file kept)', {
        companyKey,
        file,
        error: error?.message || String(error),
      });
      await fs
        .rename(file, `${file}.corrupt-${Date.now()}`)
        .catch(() => {});
    }
    entry.data = emptyState(companyKey);
  }
  return entry.data;
}

/** Serialise writes per company and commit atomically (temp file + rename). */
function persist(companyKey) {
  const entry = cacheFor(companyKey);
  entry.writeChain = entry.writeChain.then(async () => {
    const file = stateFilePath(companyKey);
    const tmp = `${file}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(entry.data, null, 2), 'utf8');
      await fs.rename(tmp, file);
    } catch (error) {
      logger.error('draftPostState: failed to persist state', {
        companyKey,
        file,
        error: error?.message || String(error),
      });
    }
  });
  return entry.writeChain;
}

/**
 * The stored record for one draft, or null if it has never been attempted.
 *
 * @param {string} companyKey
 * @param {string|number} approvalRequestId
 * @param {string|number} draftEntry
 */
export async function getRecord(companyKey, approvalRequestId, draftEntry) {
  const state = await load(companyKey);
  return state.drafts[draftKey(approvalRequestId, draftEntry)] ?? null;
}

async function patch(companyKey, approvalRequestId, draftEntry, changes) {
  const state = await load(companyKey);
  const key = draftKey(approvalRequestId, draftEntry);
  const existing = state.drafts[key] ?? {
    approvalRequestId: String(approvalRequestId),
    draftEntry: String(draftEntry),
    attempts: 0,
    firstAttemptAt: istIso(),
  };
  state.drafts[key] = { ...existing, ...changes };
  await persist(companyKey);
  return state.drafts[key];
}

/**
 * Take an exclusive claim before POSTing. Returns false when another claim is
 * still live, so the queue poll and the inline approval path can never post the
 * same draft at the same moment.
 */
export async function claimForPost(companyKey, approvalRequestId, draftEntry) {
  const record = await getRecord(companyKey, approvalRequestId, draftEntry);
  if (record?.state === DRAFT_POST_STATE.POSTING) {
    const claimedAt = Date.parse(record.claimedAt ?? '');
    const stale = !Number.isFinite(claimedAt) || Date.now() - claimedAt > CLAIM_STALE_MS;
    if (!stale) return false;
    logger.warn('draftPostState: reclaiming a stale in-flight post', {
      companyKey,
      approvalRequestId,
      draftEntry,
      claimedAt: record.claimedAt,
    });
  }
  await patch(companyKey, approvalRequestId, draftEntry, {
    state: DRAFT_POST_STATE.POSTING,
    claimedAt: istIso(),
  });
  return true;
}

export async function markPosted(companyKey, approvalRequestId, draftEntry, { docEntry = null, docNum = null } = {}) {
  return patch(companyKey, approvalRequestId, draftEntry, {
    state: DRAFT_POST_STATE.POSTED,
    docEntry: docEntry ?? null,
    docNum: docNum ?? null,
    postedAt: istIso(),
    claimedAt: null,
    nextAttemptAt: null,
  });
}

export async function markRetrying(
  companyKey,
  approvalRequestId,
  draftEntry,
  { attempts, nextAttemptAt, classification, errorCode, errorMessage }
) {
  return patch(companyKey, approvalRequestId, draftEntry, {
    state: DRAFT_POST_STATE.RETRYING,
    attempts,
    lastAttemptAt: istIso(),
    nextAttemptAt,
    classification,
    errorCode,
    errorMessage,
    claimedAt: null,
  });
}

export async function markParked(
  companyKey,
  approvalRequestId,
  draftEntry,
  { attempts, classification, errorCode, errorMessage, docNum = null }
) {
  return patch(companyKey, approvalRequestId, draftEntry, {
    state: DRAFT_POST_STATE.PARKED,
    attempts,
    lastAttemptAt: istIso(),
    parkedAt: istIso(),
    nextAttemptAt: null,
    classification,
    errorCode,
    errorMessage,
    docNum,
    claimedAt: null,
  });
}

/** Release a claim without recording an outcome (pre-flight checks failed). */
export async function releaseClaim(companyKey, approvalRequestId, draftEntry, previousState = null) {
  return patch(companyKey, approvalRequestId, draftEntry, {
    state: previousState ?? DRAFT_POST_STATE.RETRYING,
    claimedAt: null,
  });
}

/**
 * Clear a park so the draft is eligible again — used only by the human "retry"
 * link in the alert email. Returns null when there was nothing parked.
 */
export async function clearPark(companyKey, approvalRequestId, draftEntry) {
  const record = await getRecord(companyKey, approvalRequestId, draftEntry);
  if (!record || record.state !== DRAFT_POST_STATE.PARKED) return null;
  return patch(companyKey, approvalRequestId, draftEntry, {
    state: DRAFT_POST_STATE.RETRYING,
    // A fresh retry budget, but NOT a fresh history: `everAttempted` keeps the
    // guard's verify-before-post step switched on, so if someone posted this
    // draft by hand in SAP while it sat parked, we detect that instead of
    // creating a duplicate Sales Order.
    attempts: 0,
    everAttempted: true,
    nextAttemptAt: null,
    claimedAt: null,
    unparkedAt: istIso(),
  });
}

export async function listParked(companyKey) {
  const state = await load(companyKey);
  return Object.values(state.drafts).filter((r) => r?.state === DRAFT_POST_STATE.PARKED);
}

/** Test seam: drop the in-memory cache so a fresh file is read. */
export function __resetCache() {
  caches.clear();
}
