import nodemailer from 'nodemailer';
import { config } from '../../config/index.js';
import { createProcess, getProcess, PROCESS_STATUS } from '../approval/processStore.js';
import { getDraftAttachments } from '../sap/attachmentService.js';
import { getSalesOrderChangeStatus } from '../sap/draftStatusService.js';
import { currentSL, currentCompany, currentCompanyHash } from '../company/companyContext.js';
import { absoluteActionUrl } from '../../utils/appUrls.js';
import logger from '../../config/logger.js';

// Development-only fallback so testing is not blocked if SAP /Users resolution
// yields no UserCode. Production always resolves the UserCode from SAP.
const DEV_TEST_APPROVER_USERCODE_MAP = Object.freeze({
  1: 'sap01',
  2: 'manager',
});

// While EMAIL_MODE=development, approval emails are delivered only to these
// addresses so testing never reaches real approvers. EMAIL_MODE=production
// lifts the guard and mails the actual approver.
const TEST_EMAIL_ALLOWLIST = new Set(['sap1@matangiindustries.com', 'moksha.dave@growexx.com']);

export function isTestAllowedRecipient(email) {
  return TEST_EMAIL_ALLOWLIST.has(String(email || '').trim().toLowerCase());
}

/** Whether the given recipient may actually be emailed under the current EMAIL_MODE. */
export function canDeliverToRecipient(email) {
  return config.emailMode === 'production' || isTestAllowedRecipient(email);
}

/**
 * Resolve the approver's SAP UserCode (login name) and email from the SAP Users
 * entity. UserCode is what the server later logs in with; email is where the
 * approval request is sent.
 *
 * @param {number|string} sapUserId - SAP UserID / InternalKey from the approval line.
 * @returns {Promise<{userCode: string|null, email: string|null, name: string|null}>}
 */
async function resolveSapUser(sapUserId) {
  try {
    await currentSL().ensureLoggedIn();
    const response = await currentSL().client.get(
      `/Users(${encodeURIComponent(sapUserId)})?$select=UserCode,UserName,eMail`
    );
    const user = response?.data ?? response;
    return {
      userCode: user?.UserCode ?? null,
      email: user?.eMail ?? null,
      name: user?.UserName ?? null,
    };
  } catch (error) {
    logger.warn('approvalEmailService: SAP /Users resolution failed', {
      sapUserId,
      error: error?.message || String(error),
    });
    return { userCode: null, email: null, name: null };
  }
}

const DEV_TEST_APPROVER_MAP = Object.freeze({
  1: { name: 'Stage 1 Approver', email: 'sap1@matangiindustries.com' },
  2: { name: 'Stage 2 Approver', email: 'moksha.dave@growexx.com' },
});

// One SMTP transport per company sender, built lazily and cached by company key.
// Each company mails from its own configured identity (e.g. MILLP from
// approval@matangiindustries.com, MSPL from approval@minalspecialities.com).
const transportersByCompany = new Map();
function getTransporter(companyKey, smtp) {
  let transporter = transportersByCompany.get(companyKey);
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
    });
    transportersByCompany.set(companyKey, transporter);
  }
  return transporter;
}

function assertEmailConfig(smtp) {
  if (!config.appBaseUrl) {
    throw new Error('APP_BASE_URL is not configured.');
  }
  if (!smtp?.host) {
    throw new Error('SMTP host is not configured for this company.');
  }
  if (!smtp?.from) {
    throw new Error('SMTP from-address is not configured for this company.');
  }
}

async function resolveApproverContact(approverInfo = {}) {
  const source = approverInfo && typeof approverInfo === 'object' ? approverInfo : { stageId: approverInfo };
  const stagePosition =
    source.approverPosition ??
    source.approverOrder ??
    source.position ??
    source.stagePosition ??
    source.stageOrder ??
    source.stageIndex ??
    source.stageId ??
    source.stageCode ??
    source.currentStage ??
    source.stage;
  const userId = source.approverUserId ?? source.userId ?? source.userID ?? source.approver?.userId ?? null;

  if (process.env.NODE_ENV !== 'development') {
    throw new Error(
      'resolveApproverContact: no production contact resolution implemented. Refusing to run outside development to prevent misdirected emails.'
    );
  }

  const contact = DEV_TEST_APPROVER_MAP[String(stagePosition)];

  if (!contact) {
    throw new Error(`resolveApproverContact: no dev mapping for approver position ${stagePosition ?? 'unknown'} (UserID ${userId ?? 'unknown'}).`);
  }

  return {
    name: contact.name,
    email: contact.email,
    approverUserId: userId,
    stageId: stagePosition,
  };
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === 'object') {
    return [value];
  }

  return [];
}

function formatMoney(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(2) : String(value);
}

function formatQuantity(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  const num = Number(value);
  return Number.isFinite(num) ? String(num) : String(value);
}

function getSapDateTimeSortValue(updateDate, updateTime) {
  const date = String(updateDate ?? '').trim();
  const time = String(updateTime ?? '').trim();
  if (!date) {
    return 0;
  }

  const normalizedTime = time && /^\d+$/.test(time) && time.length === 6
    ? `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`
    : time;
  const parsed = Date.parse(`${date}T${normalizedTime || '00:00:00'}`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatSapDateTimeDisplay(updateDate, updateTime) {
  const date = String(updateDate ?? '').trim();
  const time = String(updateTime ?? '').trim();

  if (!date && !time) {
    return '';
  }

  if (time && /^\d{6}$/.test(time)) {
    return `${date} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`.trim();
  }

  return `${date} ${time}`.trim();
}

// Payment terms are static reference data; cache the code -> name lookup so a
// hot path (every approval email) doesn't re-query the Service Layer each time.
const paymentTermNameCache = new Map();
async function resolvePaymentTermName(code) {
  if (code === undefined || code === null || code === '' || Number(code) < 0) {
    return '';
  }
  const key = String(code);
  if (paymentTermNameCache.has(key)) {
    return paymentTermNameCache.get(key);
  }
  try {
    const response = await currentSL().client.get(
      `/PaymentTermsTypes(${encodeURIComponent(code)})?$select=PaymentTermsGroupName`
    );
    const name = (response?.data ?? response)?.PaymentTermsGroupName ?? '';
    paymentTermNameCache.set(key, name);
    return name;
  } catch {
    return '';
  }
}

// Resolve an item master name (OITM.ItemName) for a code, memoized per email so
// repeated codes across lines cost one Service Layer call. Not cached across
// emails: item names are per-company and can be renamed, so each email reads
// current data.
async function resolveItemName(itemCode, memo) {
  const key = String(itemCode ?? '').trim();
  if (!key) {
    return '';
  }
  if (memo.has(key)) {
    return memo.get(key);
  }
  let name = '';
  try {
    const response = await currentSL().client.get(`/Items('${encodeURIComponent(key)}')?$select=ItemName`);
    name = (response?.data ?? response)?.ItemName ?? '';
  } catch (error) {
    logger.warn('approvalEmailService: item name resolution failed', {
      itemCode: key,
      error: error?.message || String(error),
    });
  }
  memo.set(key, name);
  return name;
}

// Attach each line's packing item name: OITM.ItemName for the line's packing
// code (RDR1/DRF1 U_Pcode).
async function attachPackingItemNames(lines) {
  const memo = new Map();
  const enriched = [];
  for (const line of lines) {
    enriched.push({ ...line, PackingItemName: await resolveItemName(line?.U_Pcode, memo) });
  }
  return enriched;
}

async function resolveDraftEmailData({ approvalRequestId, draftEntry }) {
  await currentSL().ensureLoggedIn();

  let resolvedDraftEntry = draftEntry;

  if (resolvedDraftEntry === undefined || resolvedDraftEntry === null || resolvedDraftEntry === '') {
    const approvalResponse = await currentSL().client.get(
      `/ApprovalRequests(${encodeURIComponent(approvalRequestId)})?$select=DraftEntry`
    );
    const approvalRequest = approvalResponse?.data ?? approvalResponse;
    resolvedDraftEntry = approvalRequest?.DraftEntry ?? approvalRequest?.draftEntry;
  }

  if (resolvedDraftEntry === undefined || resolvedDraftEntry === null || resolvedDraftEntry === '') {
    throw new Error(`Unable to resolve DraftEntry for approval request ${approvalRequestId}`);
  }

  const draftResponse = await currentSL().client.get(`/Drafts(${encodeURIComponent(resolvedDraftEntry)})`);
  const draft = draftResponse?.data ?? draftResponse;

  return {
    approvalRequestId,
    draftEntry: resolvedDraftEntry,
    cardName: draft?.CardName ?? '',
    docNum: draft?.DocNum ?? '',
    paymentTermName: await resolvePaymentTermName(draft?.PaymentGroupCode),
    incoterm: draft?.U_Incoterms ?? '',
    remark: draft?.Comments ?? '',
    documentLines: await attachPackingItemNames(normalizeArray(draft?.DocumentLines)),
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function buildApprovalHistory(approvalRequest) {
  const decidedLines = (approvalRequest?.ApprovalRequestLines || [])
    .map((line, index) => ({ ...line, approverPosition: index + 1 }))
    .filter((line) => line?.Status === 'ardApproved')
    .sort(
      (a, b) =>
        getSapDateTimeSortValue(a?.UpdateDate, a?.UpdateTime) - getSapDateTimeSortValue(b?.UpdateDate, b?.UpdateTime)
    );

  const history = [];

  for (const line of decidedLines) {
    // Show the approver by their SAP UserCode (OUSR), e.g. "Approved by manager".
    const sapUser = await resolveSapUser(line?.UserID);
    const displayName = sapUser.userCode || sapUser.name || `User ${line?.UserID}`;

    history.push({
      name: displayName,
      stageCode: line?.StageCode,
      decidedAt: formatSapDateTimeDisplay(line?.UpdateDate, line?.UpdateTime),
    });
  }

  return history;
}

function buildApprovalHistoryHtml(history) {
  if (!history || history.length === 0) {
    return '';
  }

  const rows = history
    .map(
      (entry) => `
      <div style="padding:6px 16px; font-size:13px; color:#1a7f37;">
        &#10003; Approved by <strong>${escapeHtml(entry.name)}</strong> - ${escapeHtml(entry.decidedAt)}
      </div>`
    )
    .join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0fdf4; border-radius:6px; margin-bottom:16px;">
      ${rows}
    </table>`;
}

/** Small colored pill next to the email title: green "NEW SALES ORDER" or amber "UPDATED SALES ORDER". */
function buildChangeStatusBadgeHtml(changeStatus) {
  if (!changeStatus) return '';
  const bg = changeStatus.code === 'CREATED' ? '#16a34a' : '#d97706';
  return `<span style="display:inline-block; margin-left:10px; background-color:${bg}; color:#ffffff; font-size:11px; font-weight:bold; letter-spacing:0.3px; padding:3px 10px; border-radius:12px; vertical-align:middle;">${escapeHtml(
    changeStatus.label.toUpperCase()
  )}</span>`;
}

function buildApprovalEmailHtml({
  cardName,
  paymentTermName = '',
  incoterm = '',
  remark = '',
  documentLines,
  actionUrl,
  history = [],
  changeStatus = null,
}) {
  const lineRows = documentLines.length
    ? documentLines
        .map(
          (line, index) => `
            <tr>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px;">${index + 1}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px;">${escapeHtml(line?.ItemDescription ?? '')}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px;">${escapeHtml(line?.FreeText ?? '')}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px;">${escapeHtml(line?.U_Pcode ?? '')}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px;">${escapeHtml(line?.PackingItemName ?? '')}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px; text-align:right;">${escapeHtml(formatQuantity(line?.Quantity))}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px; text-align:right;">${escapeHtml(formatMoney(line?.Price ?? line?.UnitPrice))}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px;">${escapeHtml(line?.Currency ?? '')}</td>
            </tr>`
        )
        .join('')
    : `
            <tr>
              <td colspan="8" style="padding:12px; border-top:1px solid #e5e7eb; color:#6b7280; font-size:13px;">No draft lines found.</td>
            </tr>`;

  const metaRow = (label, value) =>
    `<tr><td style="padding:6px 16px; color:#666666; font-size:13px;">${label}</td><td style="padding:6px 16px; color:#111111; font-size:13px; font-weight:bold;">${escapeHtml(
      value ?? ''
    )}</td></tr>`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0; padding:0; background-color:#f4f5f7; font-family:Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7; padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="background-color:#1a2b4c; padding:20px 32px;">
              <span style="color:#ffffff; font-size:18px; font-weight:bold;">Approval Required</span>${buildChangeStatusBadgeHtml(changeStatus)}
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 8px 32px;">
              <p style="margin:0 0 16px 0; color:#333333; font-size:15px;">
                Hi,
              </p>
              <p style="margin:0 0 20px 0; color:#333333; font-size:15px;">
                A Sales Order draft is waiting for your approval.
              </p>
              ${buildApprovalHistoryHtml(history)}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb; border-radius:6px; padding:16px; margin-bottom:24px;">
                ${metaRow('Customer', cardName)}
                ${metaRow('Payment Term', paymentTermName)}
                ${metaRow('Incoterms', incoterm)}
                ${metaRow('Remark', remark)}
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-bottom:24px;">
                <tr style="background:#1a2b4c; color:#ffffff;">
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">Sr.No.</th>
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">Product Name</th>
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">Brand Name</th>
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">Packing Code</th>
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">Packing Name</th>
                  <th style="text-align:right; padding:10px 12px; font-size:13px;">Quantity</th>
                  <th style="text-align:right; padding:10px 12px; font-size:13px;">Price</th>
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">Currency</th>
                </tr>
                ${lineRows}
              </table>

            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 32px 32px;" align="center">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <a href="${actionUrl}" style="display:inline-block; background-color:#1a2b4c; color:#ffffff; text-decoration:none; font-size:15px; font-weight:bold; padding:14px 36px; border-radius:6px;">Take Action</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 24px 32px; border-top:1px solid #eeeeee;">
              <p style="margin:0; color:#999999; font-size:11px;">
                This link is unique to you and expires automatically. If you weren't expecting this email, please contact your SAP administrator.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();
}

export async function sendApprovalEmail({ approvalRequestId, approverUserId, approverPosition, stageId, draftEntry, processId }) {
  const company = currentCompany();
  const smtp = company.smtp;
  assertEmailConfig(smtp);
  const stagePosition = approverPosition ?? stageId ?? null;

  const approvalRequestResponse = await currentSL().client.get(
    `/ApprovalRequests(${encodeURIComponent(approvalRequestId)})?$select=ApprovalRequestLines,ObjectEntry`
  );
  const approvalRequest = approvalRequestResponse?.data ?? approvalRequestResponse;
  const history = await buildApprovalHistory(approvalRequest);
  const changeStatus = getSalesOrderChangeStatus(approvalRequest);

  const sapUser = await resolveSapUser(approverUserId);
  const devUserCode =
    process.env.NODE_ENV === 'development' ? DEV_TEST_APPROVER_USERCODE_MAP[String(stagePosition)] : undefined;
  const userCode = sapUser.userCode ?? devUserCode ?? null;

  if (!userCode) {
    throw new Error(
      `approvalEmailService: could not resolve SAP UserCode for approver UserID ${approverUserId} (stage ${stagePosition}).`
    );
  }

  const contact = await resolveApproverContact({
    approverUserId,
    approverPosition: stagePosition,
  });
  const recipientEmail = sapUser.email || contact.email;

  // In development mode only allowlisted test recipients are emailed; production
  // mails the real approver (EMAIL_MODE).
  if (!canDeliverToRecipient(recipientEmail)) {
    logger.warn('approvalEmailService: recipient not allowed in development EMAIL_MODE — skipping send', {
      approvalRequestId,
      approverUserId,
      to: recipientEmail,
    });
    return { skipped: true, reason: 'recipient_not_in_test_allowlist', to: recipientEmail };
  }

  const draftEmailData = await resolveDraftEmailData({
    approvalRequestId,
    draftEntry,
  });

  // Reuse the existing link when resending a failed email; only mint a new
  // process when there is no usable one (missing, already decided, or expired).
  let effectiveProcessId = processId ?? null;
  if (effectiveProcessId) {
    const existing = await getProcess(effectiveProcessId);
    const reusable =
      existing && existing.status === PROCESS_STATUS.PENDING && new Date(existing.expires_at).getTime() > Date.now();
    if (!reusable) {
      effectiveProcessId = null;
    }
  }
  if (!effectiveProcessId) {
    const processRow = await createProcess({
      approvalRequestId,
      draftEntry: draftEmailData.draftEntry,
      sapUserId: approverUserId,
      userCode,
      approverEmail: recipientEmail,
      level: stagePosition,
    });
    effectiveProcessId = processRow.id;
  }

  const actionUrl = absoluteActionUrl(currentCompanyHash(), effectiveProcessId);

  const html = buildApprovalEmailHtml({
    cardName: draftEmailData.cardName,
    paymentTermName: draftEmailData.paymentTermName,
    incoterm: draftEmailData.incoterm,
    remark: draftEmailData.remark,
    documentLines: draftEmailData.documentLines,
    actionUrl,
    history,
    changeStatus,
  });

  // Attach the draft's uploaded files (best-effort; unreadable files are skipped).
  const attachments = await getDraftAttachments(draftEmailData.draftEntry);

  logger.info('approvalEmailService: preparing to send', {
    approvalRequestId,
    approverUserId,
    userCode,
    processId: effectiveProcessId,
    approverPosition: stagePosition,
    to: recipientEmail,
    company: company.key,
    smtpHost: smtp.host,
    smtpFrom: smtp.from,
    draftEntry: draftEmailData.draftEntry,
    lineCount: draftEmailData.documentLines.length,
    attachments: attachments.length,
  });

  try {
    const result = await getTransporter(company.key, smtp).sendMail({
      from: smtp.from,
      to: recipientEmail,
      subject: `Approval Required: Sales Order ${draftEmailData.docNum}`,
      html,
      attachments,
    });

    logger.info('approvalEmailService: send completed', {
      approvalRequestId,
      approverUserId,
      processId: effectiveProcessId,
      to: recipientEmail,
      draftEntry: draftEmailData.draftEntry,
      messageId: result?.messageId || null,
      accepted: result?.accepted || [],
      rejected: result?.rejected || [],
    });
  } catch (err) {
    logger.error('approvalEmailService: send failed', {
      approvalRequestId,
      approverUserId,
      processId: effectiveProcessId,
      to: recipientEmail,
      draftEntry: draftEmailData.draftEntry,
      error: err.message,
    });
    // Carry the process id so a retry reuses the same link instead of minting a new one.
    err.processId = effectiveProcessId;
    throw err;
  }

  return { processId: effectiveProcessId };
}

export {
  buildApprovalEmailHtml,
  buildApprovalHistory,
  buildApprovalHistoryHtml,
  resolveApproverContact,
  resolveDraftEmailData,
};
