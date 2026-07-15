import nodemailer from 'nodemailer';
import { config } from '../../config/index.js';
import { generateActionTokenPair } from '../security/tokenService.js';
import { sapSessionManager } from '../../sap/SapSessionManager.js';
import logger from '../../config/logger.js';

const DEV_TEST_APPROVER_MAP = Object.freeze({
  1: { name: 'Stage 1 Approver', email: 'sap1@matangiindustries.com' },
  2: { name: 'Stage 2 Approver', email: 'moksha.dave@growexx.com' },
});

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465,
  auth: {
    user: config.smtp.user,
    pass: config.smtp.pass,
  },
});

function assertEmailConfig() {
  if (!config.appBaseUrl) {
    throw new Error('APP_BASE_URL is not configured.');
  }

  if (!config.smtp.host) {
    throw new Error('SMTP_HOST is not configured.');
  }

  if (!config.smtp.from) {
    throw new Error('SMTP_FROM is not configured.');
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

async function resolveDraftEmailData({ approvalRequestId, draftEntry }) {
  await sapSessionManager.ensureLoggedIn();

  let resolvedDraftEntry = draftEntry;

  if (resolvedDraftEntry === undefined || resolvedDraftEntry === null || resolvedDraftEntry === '') {
    const approvalResponse = await sapSessionManager.client.get(
      `/ApprovalRequests(${encodeURIComponent(approvalRequestId)})?$select=DraftEntry`
    );
    const approvalRequest = approvalResponse?.data ?? approvalResponse;
    resolvedDraftEntry = approvalRequest?.DraftEntry ?? approvalRequest?.draftEntry;
  }

  if (resolvedDraftEntry === undefined || resolvedDraftEntry === null || resolvedDraftEntry === '') {
    throw new Error(`Unable to resolve DraftEntry for approval request ${approvalRequestId}`);
  }

  const draftResponse = await sapSessionManager.client.get(`/Drafts(${encodeURIComponent(resolvedDraftEntry)})`);
  const draft = draftResponse?.data ?? draftResponse;

  return {
    approvalRequestId,
    draftEntry: resolvedDraftEntry,
    cardName: draft?.CardName ?? '',
    docNum: draft?.DocNum ?? '',
    docDueDate: draft?.DocDueDate ?? '',
    documentLines: normalizeArray(draft?.DocumentLines),
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
    const contact = await resolveApproverContact({
      approverUserId: line?.UserID,
      approverPosition: line?.approverPosition,
    });

    history.push({
      name: contact.name,
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

function buildApprovalEmailHtml({
  approverName,
  docNum,
  docDueDate,
  cardName,
  documentLines,
  approveUrl,
  rejectUrl,
  history = [],
}) {
  const lineRows = documentLines.length
    ? documentLines
        .map(
          (line, index) => `
            <tr>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px;">${index + 1}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px;">${escapeHtml(line?.ItemDescription ?? '')}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px;">${escapeHtml(formatQuantity(line?.Quantity))}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px;">${escapeHtml(line?.MeasureUnit ?? line?.UnitOfMeasurement ?? '')}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px;">${escapeHtml(formatMoney(line?.Price ?? line?.UnitPrice))}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; color:#111827; font-size:13px;">${escapeHtml(formatMoney(line?.LineTotal))}</td>
            </tr>`
        )
        .join('')
    : `
            <tr>
              <td colspan="6" style="padding:12px; border-top:1px solid #e5e7eb; color:#6b7280; font-size:13px;">No draft lines found.</td>
            </tr>`;

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
              <span style="color:#ffffff; font-size:18px; font-weight:bold;">Approval Required</span>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 8px 32px;">
              <p style="margin:0 0 16px 0; color:#333333; font-size:15px;">
                Hi ${escapeHtml(approverName)},
              </p>
              <p style="margin:0 0 20px 0; color:#333333; font-size:15px;">
                A Sales Order draft is waiting for your approval.
              </p>
              ${buildApprovalHistoryHtml(history)}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb; border-radius:6px; padding:16px; margin-bottom:24px;">
                <tr><td style="padding:6px 16px; color:#666666; font-size:13px;">Document No.</td><td style="padding:6px 16px; color:#111111; font-size:13px; font-weight:bold;">${escapeHtml(docNum)}</td></tr>
                <tr><td style="padding:6px 16px; color:#666666; font-size:13px;">Customer</td><td style="padding:6px 16px; color:#111111; font-size:13px; font-weight:bold;">${escapeHtml(cardName)}</td></tr>
                <tr><td style="padding:6px 16px; color:#666666; font-size:13px;">Due Date</td><td style="padding:6px 16px; color:#111111; font-size:13px; font-weight:bold;">${escapeHtml(docDueDate)}</td></tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-bottom:24px;">
                <tr style="background:#1a2b4c; color:#ffffff;">
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">#</th>
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">Item Name</th>
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">Quantity</th>
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">UoM</th>
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">Rate / Unit Price</th>
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">Line Total</th>
                </tr>
                ${lineRows}
              </table>

            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 32px 32px;" align="center">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding-right:10px;">
                    <a href="${approveUrl}" style="display:inline-block; background-color:#1a7f37; color:#ffffff; text-decoration:none; font-size:14px; font-weight:bold; padding:12px 28px; border-radius:6px;">Approve</a>
                  </td>
                  <td>
                    <a href="${rejectUrl}" style="display:inline-block; background-color:#b42318; color:#ffffff; text-decoration:none; font-size:14px; font-weight:bold; padding:12px 28px; border-radius:6px;">Reject</a>
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

export async function sendApprovalEmail({ approvalRequestId, approverUserId, approverPosition, stageId, draftEntry }) {
  assertEmailConfig();
  const stagePosition = approverPosition ?? stageId ?? null;

  const approvalRequestResponse = await sapSessionManager.client.get(
    `/ApprovalRequests(${encodeURIComponent(approvalRequestId)})?$select=ApprovalRequestLines`
  );
  const approvalRequest = approvalRequestResponse?.data ?? approvalRequestResponse;
  const history = await buildApprovalHistory(approvalRequest);
  const contact = await resolveApproverContact({
    approverUserId,
    approverPosition: stagePosition,
  });
  const draftEmailData = await resolveDraftEmailData({
    approvalRequestId,
    draftEntry,
  });

  const { approveToken, rejectToken } = generateActionTokenPair({
    approvalRequestId,
    approverUserId,
    stageId: stagePosition,
  });

  const baseUrl = config.appBaseUrl.replace(/\/+$/, '');
  const approveUrl = `${baseUrl}/api/v1/approve/${approveToken}`;
  const rejectUrl = `${baseUrl}/api/v1/reject/${rejectToken}`;

  const html = buildApprovalEmailHtml({
    approverName: contact.name,
    docNum: draftEmailData.docNum,
    docDueDate: draftEmailData.docDueDate,
    cardName: draftEmailData.cardName,
    documentLines: draftEmailData.documentLines,
    approveUrl,
    rejectUrl,
    history,
  });

  logger.info('approvalEmailService: preparing to send', {
    approvalRequestId,
    approverUserId,
    approverPosition: stagePosition,
    to: contact.email,
    smtpHost: config.smtp.host,
    smtpFrom: config.smtp.from,
    draftEntry: draftEmailData.draftEntry,
    lineCount: draftEmailData.documentLines.length,
  });

  try {
    const result = await transporter.sendMail({
      from: config.smtp.from,
      to: contact.email,
      subject: `Approval Required: Sales Order ${draftEmailData.docNum}`,
      html,
    });

    logger.info('approvalEmailService: send completed', {
      approvalRequestId,
      approverUserId,
      to: contact.email,
      draftEntry: draftEmailData.draftEntry,
      messageId: result?.messageId || null,
      accepted: result?.accepted || [],
      rejected: result?.rejected || [],
    });
  } catch (err) {
    logger.error('approvalEmailService: send failed', {
      approvalRequestId,
      approverUserId,
      to: contact.email,
      draftEntry: draftEmailData.draftEntry,
      error: err.message,
    });
    throw err;
  }

  return { approveToken, rejectToken };
}

export { buildApprovalEmailHtml, buildApprovalHistory, buildApprovalHistoryHtml, resolveApproverContact };
