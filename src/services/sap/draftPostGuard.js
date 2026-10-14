// The single gate every SaveDraftToDocument call must pass through.
//
// THE PROBLEM IT SOLVES: SAP allocates ORDR.DocEntry when the add transaction
// begins and keeps it on rollback. A draft that can never post was therefore
// burning one DocEntry every 30 seconds — ~2,880 a day each — because the queue
// poll re-POSTed every approved-but-unconverted draft on every cycle with no
// memory of what had already failed.
//
// THE RULE: a draft is POSTed at most once per genuine opportunity, exactly as
// a human clicking Add would. One burn per broken draft, ever — not per poll.
//   - never attempted        -> post once (this is the only unavoidable burn)
//   - permanent failure      -> park immediately; never post again unattended
//   - transient failure      -> bounded backoff, then park
//   - any repeat attempt     -> verify against SAP first, so a draft that did
//                               convert is never re-POSTed (no burn, and no
//                               duplicate Sales Order after an ambiguous timeout)
//
// The poster and verifier are injected rather than imported, so this module has
// no dependency on approvalService and both call sites (the queue poll and the
// inline post after an approval decision) share one state machine without an
// import cycle.

import logger from '../../config/logger.js';
import { classifyDraftPostFailure, DRAFT_POST_FAILURE } from './draftPostErrors.js';
import {
  DRAFT_POST_STATE,
  claimForPost,
  getRecord,
  markParked,
  markPosted,
  markRetrying,
  releaseClaim,
} from './draftPostState.js';
import { istIso } from '../audit/decisionLogShared.js';

/** Backoff before each transient retry. Its length is also the attempt cap. */
const RETRY_BACKOFF_MS = Object.freeze([
  60 * 1000, // 1 min
  5 * 60 * 1000, // 5 min
  15 * 60 * 1000, // 15 min
  60 * 60 * 1000, // 1 hour
]);

export const DRAFT_POST_RESULT = Object.freeze({
  POSTED: 'posted',
  SKIPPED: 'skipped',
  PARKED: 'parked',
  RETRY_SCHEDULED: 'retry_scheduled',
});

const skip = (reason, extra = {}) =>
  Object.freeze({ outcome: DRAFT_POST_RESULT.SKIPPED, reason, ...extra });

/**
 * Post one approved draft, at most once per real opportunity.
 *
 * @param {object} params
 * @param {string} params.companyKey
 * @param {string|number} params.approvalRequestId
 * @param {string|number} params.draftEntry
 * @param {() => Promise<object>} params.post - Performs the SaveDraftToDocument POST.
 * @param {() => Promise<number|null>} [params.verify] - Returns the final DocEntry if
 *   SAP has already converted this draft, else null. Required for retries; when
 *   omitted, a draft with a prior attempt is skipped rather than posted blind.
 * @param {(info: object) => (void|Promise<void>)} [params.onParked] - Called once,
 *   when a draft transitions to parked, so a human can be alerted.
 * @returns {Promise<Readonly<object>>}
 */
export async function postDraftGuarded({
  companyKey,
  approvalRequestId,
  draftEntry,
  post,
  verify = null,
  onParked = null,
}) {
  const ref = { companyKey, approvalRequestId, draftEntry };
  const record = await getRecord(companyKey, approvalRequestId, draftEntry);

  if (record?.state === DRAFT_POST_STATE.POSTED) {
    return skip('already_posted', { docEntry: record.docEntry ?? null });
  }

  // The whole point: a parked draft is never posted again on its own. Only the
  // retry link in the alert email (clearPark) can make it eligible.
  if (record?.state === DRAFT_POST_STATE.PARKED) {
    return skip('parked', { parkedAt: record.parkedAt ?? null });
  }

  if (record?.state === DRAFT_POST_STATE.RETRYING && record.nextAttemptAt) {
    const due = Date.parse(record.nextAttemptAt);
    if (Number.isFinite(due) && Date.now() < due) {
      return skip('backoff', { nextAttemptAt: record.nextAttemptAt });
    }
  }

  if (!(await claimForPost(companyKey, approvalRequestId, draftEntry))) {
    return skip('in_flight');
  }

  const attemptsSoFar = Number(record?.attempts ?? 0);
  // `everAttempted` survives a manual un-park, which resets the attempt budget.
  const hasHistory = attemptsSoFar > 0 || record?.everAttempted === true;

  // Anything with a prior attempt is checked against SAP before we spend
  // another DocEntry. This is what makes an ambiguous timeout safe: if the
  // earlier POST actually committed, we record it and never post a duplicate.
  if (hasHistory) {
    if (typeof verify !== 'function') {
      await releaseClaim(companyKey, approvalRequestId, draftEntry, record?.state);
      return skip('verify_unavailable');
    }
    try {
      const existingDocEntry = await verify();
      if (existingDocEntry != null) {
        await markPosted(companyKey, approvalRequestId, draftEntry, { docEntry: existingDocEntry });
        logger.info('draftPostGuard: draft was already converted in SAP; no post needed', {
          ...ref,
          docEntry: existingDocEntry,
        });
        return skip('already_converted', { docEntry: existingDocEntry });
      }
    } catch (error) {
      // Could not confirm. Posting blind risks a duplicate and a burn, so wait.
      await releaseClaim(companyKey, approvalRequestId, draftEntry, record?.state);
      logger.warn('draftPostGuard: could not verify draft state; skipping this cycle', {
        ...ref,
        error: error?.message || String(error),
      });
      return skip('verify_failed');
    }
  }

  let salesOrder;
  try {
    salesOrder = await post();
  } catch (error) {
    return handleFailure({ ...ref, attemptsSoFar, error, onParked });
  }

  const docEntry = salesOrder?.DocEntry ?? salesOrder?.docEntry ?? null;
  const docNum = salesOrder?.DocNum ?? salesOrder?.docNum ?? null;
  await markPosted(companyKey, approvalRequestId, draftEntry, { docEntry, docNum });
  logger.info('draftPostGuard: posted approved draft', { ...ref, docEntry, docNum });
  return Object.freeze({ outcome: DRAFT_POST_RESULT.POSTED, docEntry, docNum, salesOrder });
}

async function handleFailure({ companyKey, approvalRequestId, draftEntry, attemptsSoFar, error, onParked }) {
  const ref = { companyKey, approvalRequestId, draftEntry };
  const verdict = classifyDraftPostFailure(error);
  const attempts = attemptsSoFar + 1;
  const detail = {
    attempts,
    classification: verdict.classification,
    errorCode: verdict.code,
    errorMessage: error?.message || String(error),
  };

  const retriesLeft = verdict.classification !== DRAFT_POST_FAILURE.PERMANENT && attempts <= RETRY_BACKOFF_MS.length;

  if (!retriesLeft) {
    const parkReason =
      verdict.classification === DRAFT_POST_FAILURE.PERMANENT ? 'permanent_failure' : 'transient_retries_exhausted';
    await markParked(companyKey, approvalRequestId, draftEntry, detail);
    logger.error('draftPostGuard: draft parked — it will NOT be posted again without a human', {
      ...ref,
      ...detail,
      parkReason,
      sapStatus: verdict.status,
    });
    if (typeof onParked === 'function') {
      try {
        await onParked({ ...ref, ...detail, parkReason, sapStatus: verdict.status });
      } catch (alertError) {
        logger.error('draftPostGuard: parked-draft alert failed to send', {
          ...ref,
          error: alertError?.message || String(alertError),
        });
      }
    }
    return Object.freeze({ outcome: DRAFT_POST_RESULT.PARKED, ...detail, parkReason });
  }

  const delayMs = RETRY_BACKOFF_MS[attempts - 1];
  const nextAttemptAt = istIso(new Date(Date.now() + delayMs));
  await markRetrying(companyKey, approvalRequestId, draftEntry, { ...detail, nextAttemptAt });
  logger.warn('draftPostGuard: transient failure; retry scheduled', {
    ...ref,
    ...detail,
    nextAttemptAt,
    delayMs,
  });
  return Object.freeze({ outcome: DRAFT_POST_RESULT.RETRY_SCHEDULED, ...detail, nextAttemptAt });
}

/**
 * A pass-through guard. Used where a test injects its own Service Layer session
 * (and therefore has no company context or state directory) so existing unit
 * tests keep exercising the raw post path unchanged.
 */
export const passthroughDraftPostGuard = Object.freeze({
  async postDraftGuarded({ post }) {
    const salesOrder = await post();
    return Object.freeze({
      outcome: DRAFT_POST_RESULT.POSTED,
      docEntry: salesOrder?.DocEntry ?? salesOrder?.docEntry ?? null,
      docNum: salesOrder?.DocNum ?? salesOrder?.docNum ?? null,
      salesOrder,
    });
  },
});

export const draftPostGuard = Object.freeze({ postDraftGuarded });

export default draftPostGuard;
