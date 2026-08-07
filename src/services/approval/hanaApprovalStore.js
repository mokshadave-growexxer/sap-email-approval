import crypto from 'crypto';
import logger from '../../config/logger.js';
import { config } from '../../config/index.js';
import { PROCESS_STATUS, PROCESS_FAILURE, DECISION_STATUS_BY_ACTION } from './processConstants.js';
import { formatLocalTime, toIntOrNull, istIso } from '../audit/decisionLogShared.js';
import { query, execute, udt } from '../sap/hanaClient.js';

const T = () => udt('AP_APPROVAL');

// All persisted timestamps are IST ISO strings (see istIso).
const nowIso = () => istIso();

function toProcess(r) {
  return {
    id: r.Code,
    approval_request_id: r.U_request_id,
    stage: r.U_stage,
    level: r.U_level,
    sap_user_id: r.U_sap_user_id,
    user_code: r.U_user_code,
    approver_email: r.U_approver_email,
    draft_entry: r.U_draft_entry,
    status: r.U_status,
    expires_at: r.U_expires_at,
    sent_at: r.U_sent_at,
    decided_at: r.U_decided_at,
  };
}

async function findActiveRow(approvalRequestId, sapUserId) {
  const rows = await query(
    `SELECT * FROM ${T()} WHERE "U_request_id" = ? AND "U_sap_user_id" = ? AND "U_status" IN ('pending','processing') LIMIT 1`,
    [String(approvalRequestId), toIntOrNull(sapUserId)]
  );
  return rows[0] ?? null;
}

// ---------- Queue interface ----------

export async function getKnownApprovalStageKeys() {
  const rows = await query(
    `SELECT "U_request_id","U_stage","U_sap_user_id" FROM ${T()} WHERE "U_status" IN ('pending','processing')`
  );
  return new Set(
    rows.map((r) => `${String(r.U_request_id ?? '')}:${String(r.U_stage ?? '')}:${String(r.U_sap_user_id ?? '')}`)
  );
}

export async function enqueue({ approvalRequestId, currentStage, approverUserId, approverPosition, draftEntry }) {
  const existing = await findActiveRow(approvalRequestId, approverUserId);
  if (existing) return existing.Code;

  const id = crypto.randomUUID();
  await execute(
    `INSERT INTO ${T()} ("Code","Name","U_request_id","U_stage","U_level","U_sap_user_id","U_draft_entry","U_email_status","U_attempts","U_status")
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      id,
      String(approvalRequestId),
      toIntOrNull(currentStage),
      toIntOrNull(approverPosition),
      toIntOrNull(approverUserId),
      toIntOrNull(draftEntry),
      'pending',
      0,
      PROCESS_STATUS.PENDING,
    ]
  );
  logger.info('hanaApprovalStore: enqueued approval record', { id, approvalRequestId, approverUserId });
  return id;
}

export async function getPendingItems() {
  return [];
}

export async function markProcessing() {}

export async function markSent(id) {
  await execute(`UPDATE ${T()} SET "U_email_status" = 'sent', "U_last_attempt_at" = ? WHERE "Code" = ?`, [nowIso(), id]);
}

export async function markSkipped(id, reason) {
  await execute(`UPDATE ${T()} SET "U_email_status" = 'skipped', "U_last_error" = ?, "U_last_attempt_at" = ? WHERE "Code" = ?`, [
    reason ?? null,
    nowIso(),
    id,
  ]);
}

export async function markFailed(id, errorMessage) {
  await execute(
    `UPDATE ${T()} SET "U_email_status" = 'failed', "U_attempts" = "U_attempts" + 1, "U_last_error" = ?, "U_last_attempt_at" = ? WHERE "Code" = ?`,
    [errorMessage ?? null, nowIso(), id]
  );
}

export async function attachProcess() {}

export async function getRetryableFailedItems({ maxAttempts, backoffMinutes }) {
  const cutoff = istIso(new Date(Date.now() - Number(backoffMinutes) * 60_000));
  const rows = await query(
    `SELECT * FROM ${T()} WHERE "U_email_status" = 'failed' AND "U_attempts" < ? AND "U_last_attempt_at" < ? ORDER BY "Code"`,
    [Number(maxAttempts), cutoff]
  );
  return rows.map((r) => ({
    id: r.Code,
    process_id: r.Code,
    approval_request_id: r.U_request_id,
    current_stage: r.U_stage,
    approver_user_id: r.U_sap_user_id,
    approver_position: r.U_level,
    draft_entry: r.U_draft_entry,
  }));
}

// ---------- Process interface ----------

export async function createProcess({
  approvalRequestId,
  draftEntry,
  sapUserId,
  userCode,
  approverEmail,
  level,
  ttlHours = config.approvalLinkTtlHours,
}) {
  const expiresAt = istIso(new Date(Date.now() + Number(ttlHours) * 3_600_000));
  const existing = await findActiveRow(approvalRequestId, sapUserId);

  if (existing) {
    await execute(
      `UPDATE ${T()} SET "U_user_code" = ?, "U_approver_email" = ?, "U_draft_entry" = ?, "U_level" = ?, "U_expires_at" = ?, "U_sent_at" = ? WHERE "Code" = ?`,
      [userCode, approverEmail ?? null, toIntOrNull(draftEntry), toIntOrNull(level), expiresAt, nowIso(), existing.Code]
    );
    const rows = await query(`SELECT * FROM ${T()} WHERE "Code" = ?`, [existing.Code]);
    logger.info('hanaApprovalStore: filled existing approval record', { id: existing.Code, approvalRequestId });
    return toProcess(rows[0]);
  }

  const id = crypto.randomUUID();
  await execute(
    `INSERT INTO ${T()} ("Code","Name","U_request_id","U_sap_user_id","U_user_code","U_approver_email","U_draft_entry","U_level","U_email_status","U_attempts","U_status","U_expires_at","U_sent_at")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      id,
      String(approvalRequestId),
      toIntOrNull(sapUserId),
      userCode,
      approverEmail ?? null,
      toIntOrNull(draftEntry),
      toIntOrNull(level),
      'pending',
      0,
      PROCESS_STATUS.PENDING,
      expiresAt,
      nowIso(),
    ]
  );
  const rows = await query(`SELECT * FROM ${T()} WHERE "Code" = ?`, [id]);
  logger.info('hanaApprovalStore: created approval record', { id, approvalRequestId });
  return toProcess(rows[0]);
}

/**
 * Every approved level of ONE approval request that carries a footprint,
 * ordered by when it was decided (earliest first). Scoping to the request is
 * what guarantees the trail written to a Sales Order can only ever contain
 * that request's own footprints — a footprint from an unrelated request can
 * never leak onto the document. (final_doc_entry is unusable for this: only
 * the final level's row is stamped with it, so lower levels would be lost.)
 */
export async function getApprovedProcessesForRequest(approvalRequestId) {
  const rows = await query(
    `SELECT "Code", "U_level", "U_footprint_id", "U_decided_at" FROM ${T()}
      WHERE "U_request_id" = ? AND "U_status" = 'approved' AND "U_footprint_id" IS NOT NULL
      ORDER BY "U_decided_at" ASC`,
    [String(approvalRequestId)]
  );
  return rows.map((r) => ({ processId: r.Code, level: r.U_level, footprintId: r.U_footprint_id, decidedAt: r.U_decided_at }));
}

export async function getProcess(processId) {
  if (!processId) return null;
  try {
    const rows = await query(`SELECT * FROM ${T()} WHERE "Code" = ?`, [processId]);
    return rows.length ? toProcess(rows[0]) : null;
  } catch (error) {
    logger.warn('hanaApprovalStore: getProcess failed', { processId, error: error?.message || String(error) });
    return null;
  }
}

export async function claimProcess(processId) {
  if (!processId) return { ok: false, reason: PROCESS_FAILURE.NOT_FOUND };

  const affected = await execute(
    `UPDATE ${T()} SET "U_status" = ? WHERE "Code" = ? AND "U_status" = ? AND "U_expires_at" > ?`,
    [PROCESS_STATUS.PROCESSING, processId, PROCESS_STATUS.PENDING, nowIso()]
  );
  if (affected === 1) {
    const rows = await query(`SELECT * FROM ${T()} WHERE "Code" = ?`, [processId]);
    return { ok: true, process: toProcess(rows[0]) };
  }

  const rows = await query(`SELECT "U_status","U_expires_at" FROM ${T()} WHERE "Code" = ?`, [processId]);
  if (!rows.length) return { ok: false, reason: PROCESS_FAILURE.NOT_FOUND };
  if (rows[0].U_status !== PROCESS_STATUS.PENDING) return { ok: false, reason: PROCESS_FAILURE.ALREADY_DECIDED };
  return { ok: false, reason: PROCESS_FAILURE.EXPIRED };
}

export async function markProcessDecided(processId, action) {
  await execute(`UPDATE ${T()} SET "U_status" = ?, "U_action" = ?, "U_decided_at" = ? WHERE "Code" = ?`, [
    DECISION_STATUS_BY_ACTION[action],
    action,
    nowIso(),
    processId,
  ]);
}

export async function releaseProcess(processId) {
  await execute(`UPDATE ${T()} SET "U_status" = ? WHERE "Code" = ? AND "U_status" = ?`, [
    PROCESS_STATUS.PENDING,
    processId,
    PROCESS_STATUS.PROCESSING,
  ]);
}

export async function expireProcess(processId) {
  await execute(`UPDATE ${T()} SET "U_status" = ? WHERE "Code" = ? AND "U_status" = ?`, [
    PROCESS_STATUS.EXPIRED,
    processId,
    PROCESS_STATUS.PENDING,
  ]);
}

// Retire a link whose stage was already decided in SAP (the add-on). Only an
// undecided local row is superseded, so a decision recorded through this
// service is never overwritten.
export async function markProcessSuperseded(processId, failureReason) {
  await execute(
    `UPDATE ${T()} SET "U_status" = ?, "U_failure_reason" = ? WHERE "Code" = ? AND "U_status" IN (?, ?)`,
    [PROCESS_STATUS.SUPERSEDED, failureReason ?? null, processId, PROCESS_STATUS.PENDING, PROCESS_STATUS.PROCESSING]
  );
}

// ---------- Decision-log interface (same row) ----------

export async function logFailedDecision({ processId, failureReason }) {
  if (processId) {
    try {
      await execute(`UPDATE ${T()} SET "U_failure_reason" = ? WHERE "Code" = ?`, [failureReason, processId]);
    } catch (error) {
      logger.warn('hanaApprovalStore: logFailedDecision failed', { processId, error: error?.message || String(error) });
    }
  }
  return { id: processId, requestId: processId };
}

export async function createPendingDecision({ processId, action, session }) {
  await execute(`UPDATE ${T()} SET "U_action" = ?, "U_footprint_id" = ? WHERE "Code" = ?`, [
    action,
    session?.session_id ?? null,
    processId,
  ]);
  return { id: processId, requestId: processId };
}

export async function markDecisionSuccess(id, { timezone, draftDocEntry, finalDocEntry }) {
  const sets = [`"U_approval_time_local" = ?`];
  const params = [formatLocalTime(new Date(), timezone)];
  if (toIntOrNull(finalDocEntry) != null) {
    sets.push(`"U_final_doc_entry" = ?`);
    params.push(toIntOrNull(finalDocEntry));
  }
  if (toIntOrNull(draftDocEntry) != null) {
    sets.push(`"U_draft_entry" = ?`);
    params.push(toIntOrNull(draftDocEntry));
  }
  params.push(id);
  await execute(`UPDATE ${T()} SET ${sets.join(', ')} WHERE "Code" = ?`, params);
}

export async function markDecisionFailed(id, failureReason) {
  await execute(`UPDATE ${T()} SET "U_failure_reason" = ? WHERE "Code" = ?`, [failureReason, id]);
}

export async function updateFinalDocEntry(id, finalDocEntry) {
  await execute(`UPDATE ${T()} SET "U_final_doc_entry" = ? WHERE "Code" = ?`, [toIntOrNull(finalDocEntry), id]);
}
