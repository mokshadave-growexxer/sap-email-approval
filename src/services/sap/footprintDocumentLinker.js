import { query, execute, udt, table } from './hanaClient.js';
import { getApprovedProcessesForRequest } from '../approval/processStore.js';
import logger from '../../config/logger.js';

/**
 * Stamp the resulting Sales Order onto every footprint captured for an approval
 * request, so each footprint row is self-describing: which document it belongs
 * to (DocEntry + DocNum) and whether that document was newly CREATED or an
 * existing one being UPDATED. Called once the final level approves and the
 * draft has become a Sales Order.
 *
 * Best-effort: never throws, so it cannot fail an already-successful approval.
 *
 * @param {{approvalRequestId: (string|number), docEntry: (string|number), changeType: string}} params
 * @param {{queryFn?: Function, execFn?: Function, getProcesses?: Function, log?: object}} [deps]
 * @returns {Promise<number>} number of footprint rows linked.
 */
export async function linkApprovalFootprintsToDocument(
  { approvalRequestId, docEntry, changeType },
  { queryFn = query, execFn = execute, getProcesses = getApprovedProcessesForRequest, log = logger } = {}
) {
  if (approvalRequestId == null || docEntry == null || docEntry === '') {
    return 0;
  }

  try {
    const docRows = await queryFn(`SELECT "DocNum" FROM ${table('ORDR')} WHERE "DocEntry" = ?`, [Number(docEntry)]);
    const docNum = docRows?.[0]?.DocNum ?? null;

    const footprintIds = (await getProcesses(approvalRequestId)).map((p) => p.footprintId).filter(Boolean);

    let linked = 0;
    for (const footprintId of footprintIds) {
      const affected = await execFn(
        `UPDATE ${udt('AP_FOOTPRINT')} SET "U_doc_entry" = ?, "U_doc_num" = ?, "U_change_type" = ? WHERE "Code" = ?`,
        [Number(docEntry), docNum == null ? null : Number(docNum), changeType ?? null, footprintId]
      );
      linked += affected > 0 ? 1 : 0;
    }

    log.info('footprintDocumentLinker: linked footprints to Sales Order', {
      approvalRequestId: String(approvalRequestId),
      docEntry: String(docEntry),
      docNum,
      changeType,
      linked,
    });
    return linked;
  } catch (error) {
    log.warn('footprintDocumentLinker: could not link footprints to Sales Order', {
      approvalRequestId: String(approvalRequestId),
      docEntry: String(docEntry),
      error: error?.message || String(error),
    });
    return 0;
  }
}
