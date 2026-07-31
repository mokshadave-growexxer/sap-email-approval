import { execute, table } from './hanaClient.js';
import logger from '../../config/logger.js';

const WDD1_REMARKS_MAX = 254;

/**
 * Persist an approver's decision remark onto their approval line so it shows in
 * SAP's Approval Status Report (WDD1.Remarks). The Service Layer's
 * ApprovalRequestDecisions.Remarks is written only intermittently — it is
 * dropped on the final-stage decision that also triggers the draft-to-document
 * conversion — so the remark is written here directly and deterministically.
 *
 * A WDD1 row is identified by its request (WddCode) and the deciding user
 * (UserID); the stage code is shared across an approval's lines and does not
 * distinguish them. Best-effort: never throws, so it cannot fail an
 * already-successful decision.
 *
 * @param {{approvalRequestId: (string|number), sapUserId: (string|number), remark: string}} params
 * @param {{exec?: Function, log?: object}} [deps] - Injection seam for tests.
 * @returns {Promise<boolean>} true if a line was updated.
 */
export async function writeDecisionRemark({ approvalRequestId, sapUserId, remark }, { exec = execute, log = logger } = {}) {
  const text = (remark ?? '').trim();
  if (!text || approvalRequestId == null || sapUserId == null) {
    return false;
  }

  try {
    const affected = await exec(
      `UPDATE ${table('WDD1')} SET "Remarks" = ? WHERE "WddCode" = ? AND "UserID" = ?`,
      [text.slice(0, WDD1_REMARKS_MAX), Number(approvalRequestId), Number(sapUserId)]
    );
    log.info('decisionRemarkStore: wrote decision remark to WDD1', {
      approvalRequestId: String(approvalRequestId),
      sapUserId: String(sapUserId),
      rowsAffected: affected,
    });
    return affected > 0;
  } catch (error) {
    log.warn('decisionRemarkStore: could not write decision remark to WDD1', {
      approvalRequestId: String(approvalRequestId),
      sapUserId: String(sapUserId),
      error: error?.message || String(error),
    });
    return false;
  }
}
