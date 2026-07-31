export const DRAFT_CHANGE_STATUS = Object.freeze({
  CREATED: Object.freeze({ code: 'CREATED', label: 'New Sales Order' }),
  UPDATED: Object.freeze({ code: 'UPDATED', label: 'Updated Sales Order' }),
});

/**
 * Whether an approval request is for a brand-new Sales Order or for a change to
 * one that already exists.
 *
 * SAP populates ApprovalRequest.ObjectEntry with the target document's DocEntry
 * as soon as the request is raised for an edit to an EXISTING, already-approved
 * Sales Order — even while the request is still pending. For a request to
 * create a document for the first time, ObjectEntry stays null/0 until that
 * request is fully approved and the new document is created. So checking
 * ObjectEntry while the request is pending (i.e. before any decision) tells us
 * which case this is:
 *   - null/0        -> a brand-new Sales Order is being created ("New")
 *   - a real DocEntry -> an existing Sales Order is being modified ("Updated")
 *
 * This reads a field already fetched for the approval email, so it needs no
 * extra SAP/HANA call, and — because ObjectEntry is fixed for the lifetime of
 * one approval request — every level's email for the same request agrees.
 *
 * @param {{ObjectEntry?: number|string|null}} approvalRequest
 * @returns {{code: string, label: string}}
 */
export function getSalesOrderChangeStatus(approvalRequest) {
  const hasExistingTarget = Number(approvalRequest?.ObjectEntry) > 0;
  return hasExistingTarget ? DRAFT_CHANGE_STATUS.UPDATED : DRAFT_CHANGE_STATUS.CREATED;
}
