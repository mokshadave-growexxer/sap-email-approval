import { LINE_STATUS } from './approvalService.js';

// Single source for the SAP ApprovalRequests reads shared by the queue worker
// (instant emails, draft conversion) and the daily digest. Keeping the OData
// query strings and the "who can act now" rule in one place guarantees the two
// channels always agree on what is pending and actionable.

export const PENDING_APPROVALS_PATH =
  "/ApprovalRequests?$filter=Status%20eq%20'arsPending'%20and%20ObjectType%20eq%20'17'%20and%20IsDraft%20eq%20'Y'" +
  '&$select=Code,Status,CurrentStage,ObjectType,IsDraft,ObjectEntry,DraftEntry,CreationDate,ApprovalRequestLines';

export const APPROVED_DRAFTS_PATH =
  "/ApprovalRequests?$filter=Status%20eq%20'arsApproved'%20and%20ObjectType%20eq%20'17'%20and%20IsDraft%20eq%20'Y'" +
  '&$select=Code,Status,CurrentStage,ObjectType,IsDraft,ObjectEntry,DraftEntry,CreationDate';

/**
 * An approval request is only handled when the SO was punched or updated on/after
 * this date (its ApprovalRequest.CreationDate). Editing a draft mints a new
 * request dated to the edit, so this catches both "punched" and "updated". A
 * null cutoff (injected tests) disables the filter.
 */
export function isBeforeCreatedCutoff(creationDate, cutoffDate) {
  if (!cutoffDate) {
    return false;
  }
  const created = String(creationDate ?? '').slice(0, 10);
  return created < cutoffDate;
}

/**
 * The single approver who may act on this request RIGHT NOW: the first still-
 * pending line at the request's current stage. Returns [] when no line at the
 * current stage is actionable (e.g. an earlier line at the same stage is still
 * pending). Returned as an array to preserve the caller shape.
 */
export function getActionableApprovers(approvalRequest) {
  const lines = approvalRequest.ApprovalRequestLines || [];
  for (const [index, line] of lines.entries()) {
    if (Number(line.StageCode) !== Number(approvalRequest.CurrentStage)) {
      continue;
    }

    if (line.Status !== LINE_STATUS.PENDING) {
      continue;
    }

    const priorPending = lines.slice(0, index).some(
      (previousLine) =>
        Number(previousLine.StageCode) === Number(approvalRequest.CurrentStage) &&
        previousLine.Status === LINE_STATUS.PENDING
    );

    if (priorPending) {
      break;
    }

    return [{ ...line, approverPosition: index + 1 }];
  }

  return [];
}

/**
 * Follow SAP Service Layer OData pagination (@odata.nextLink) so EVERY page of a
 * result is fetched, not just the first (default 20 per page).
 *
 * @param {{ client: { get: Function } }} session - Service Layer session.
 * @param {string} firstPath - First page path.
 * @returns {Promise<Array<object>>}
 */
export async function getAllPages(session, firstPath) {
  const all = [];
  let path = firstPath;
  let guard = 0;
  while (path && guard < 500) {
    guard += 1;
    const response = await session.client.get(path);
    const data = response?.data ?? response ?? {};
    const page = Array.isArray(data) ? data : data.value ?? [];
    all.push(...page);
    const next = data['@odata.nextLink'] ?? data['odata.nextLink'] ?? null;
    if (!next) break;
    path = /^https?:\/\//i.test(next) ? next : `/${String(next).replace(/^\/+/, '')}`;
  }
  return all;
}
