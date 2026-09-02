import fs from 'fs/promises';
import { query, table } from './hanaClient.js';
import logger from '../../config/logger.js';

// Keep total attachment payload under a typical SMTP limit (Gmail ~25 MB).
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const tbl = (name) => table(name);

/**
 * Build the on-disk path of a SAP B1 attachment from its ATC1 row.
 * @returns {string}
 */
export function buildAttachmentPath(srcPath, fileName, fileExt) {
  const overridePath = process.env.ATTACHMENT_BASE_PATH;
  const raw = String(overridePath || srcPath || '');
  const sep = raw.includes('/') && !raw.includes('\\') ? '/' : '\\';
  const base = raw.replace(/[\\/]+$/, '');
  const name = fileExt ? `${fileName}.${fileExt}` : String(fileName);
  return `${base}${sep}${name}`;
}

/**
 * Read the attachments linked to a Sales Order draft and return them as
 * nodemailer attachment objects. Best-effort: a file that can't be read (missing
 * or no share access) is logged and skipped — it never fails the email.
 *
 * @param {number|string} draftEntry - ODRF DocEntry.
 * @returns {Promise<Array<{filename: string, content: Buffer}>>}
 */
export async function getDraftAttachments(draftEntry) {
  if (draftEntry === undefined || draftEntry === null || draftEntry === '') return [];

  let rows;
  try {
    rows = await query(
      `SELECT T2."FileName" AS "FN", T2."FileExt" AS "EXT", T2."srcPath" AS "SRC"
         FROM ${tbl('ODRF')} T0
         JOIN ${tbl('ATC1')} T2 ON T0."AtcEntry" = T2."AbsEntry"
        WHERE T0."DocEntry" = ?
        ORDER BY T2."Line"`,
      [Number(draftEntry)]
    );
  } catch (error) {
    logger.warn('attachmentService: attachment metadata query failed', {
      draftEntry: String(draftEntry),
      error: error?.message || String(error),
    });
    return [];
  }

  if (!rows.length) return [];

  const attachments = [];
  let total = 0;
  for (const r of rows) {
    const filename = r.EXT ? `${r.FN}.${r.EXT}` : String(r.FN);
    const fullPath = buildAttachmentPath(r.SRC, r.FN, r.EXT);
    try {
      const content = await fs.readFile(fullPath);
      if (total + content.length > MAX_TOTAL_BYTES) {
        logger.warn('attachmentService: skipping attachment over size cap', { filename, bytes: content.length });
        continue;
      }
      total += content.length;
      attachments.push({ filename, content });
    } catch (error) {
      logger.warn('attachmentService: could not read attachment file', {
        filename,
        path: fullPath,
        error: error?.code || error?.message || String(error),
      });
    }
  }

  logger.info('attachmentService: resolved draft attachments', {
    draftEntry: String(draftEntry),
    found: rows.length,
    attached: attachments.length,
  });
  return attachments;
}
