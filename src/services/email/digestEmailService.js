import { config } from '../../config/index.js';
import { currentCompany } from '../company/companyContext.js';
import { getCompanyTransporter, resolveBccRecipient } from './mailer.js';
import logger from '../../config/logger.js';

// The daily digest email: a compact, scannable summary of every Sales Order
// awaiting THIS approver's decision, with one "Take Action" button to the bulk
// approve/reject page. Full line-item detail lives on that page. Fonts are
// web-safe (Arial) because email clients do not reliably render custom fonts.

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMoney(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

function formatDocDate(docDate) {
  const iso = String(docDate ?? '').slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

export function buildDigestSubject(count) {
  const n = Number(count) || 0;
  return `Pending Sales Order Approvals — ${n} awaiting your decision`;
}

function badgeHtml(changeType) {
  const isUpdated = changeType === 'UPDATED';
  const bg = isUpdated ? '#d97706' : '#16a34a';
  const label = isUpdated ? 'UPDATED' : 'NEW';
  return `<span style="display:inline-block; background-color:${bg}; color:#ffffff; font-size:10px; font-weight:bold; letter-spacing:0.3px; padding:2px 8px; border-radius:10px;">${label}</span>`;
}

export function buildDigestEmailHtml({ approverName, items = [], actionUrl }) {
  const rows = items.length
    ? items
        .map((item) => {
          const value = formatMoney(item.orderValue);
          const valueCell = value ? `${escapeHtml(item.currency || '')} ${value}`.trim() : '';
          return `
            <tr>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; font-size:13px; color:#111827; white-space:nowrap;">${escapeHtml(item.docNum)} ${badgeHtml(item.changeType)}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; font-size:13px; color:#111827;">${escapeHtml(item.cardName)}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; font-size:13px; color:#111827; text-align:right; white-space:nowrap;">${escapeHtml(valueCell)}</td>
              <td style="padding:10px 12px; border-top:1px solid #e5e7eb; font-size:13px; color:#6b7280; text-align:right; white-space:nowrap;">${escapeHtml(formatDocDate(item.docDate))}</td>
            </tr>`;
        })
        .join('')
    : `
            <tr><td colspan="4" style="padding:12px; border-top:1px solid #e5e7eb; color:#6b7280; font-size:13px;">No pending approvals.</td></tr>`;

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
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="background-color:#1a2b4c; padding:20px 32px;">
              <span style="color:#ffffff; font-size:18px; font-weight:bold;">Pending Sales Order Approvals</span>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 8px 32px;">
              <p style="margin:0 0 16px 0; color:#333333; font-size:15px;">Hi ${escapeHtml(approverName || '')},</p>
              <p style="margin:0 0 20px 0; color:#333333; font-size:15px;">
                Here is the list of all pending sales order approvals awaiting your decision.
                Open the queue to review the details and approve or reject them in bulk.
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-bottom:24px;">
                <tr style="background:#1a2b4c; color:#ffffff;">
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">Sales Order</th>
                  <th style="text-align:left; padding:10px 12px; font-size:13px;">Customer</th>
                  <th style="text-align:right; padding:10px 12px; font-size:13px;">Order Value</th>
                  <th style="text-align:right; padding:10px 12px; font-size:13px;">Date</th>
                </tr>
                ${rows}
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
                This link is unique to you. If you weren't expecting this email, please contact your SAP administrator.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

/** Send one approver's daily digest. Must run inside a company context. */
export async function sendDigestEmail({ to, approverName, items, actionUrl }) {
  const company = currentCompany();
  const smtp = company.smtp;
  if (!config.appBaseUrl) {
    throw new Error('APP_BASE_URL is not configured.');
  }
  if (!smtp?.host || !smtp?.from) {
    throw new Error('SMTP is not configured for this company.');
  }

  const html = buildDigestEmailHtml({ approverName, items, actionUrl });
  const subject = buildDigestSubject(items.length);

  logger.info('digestEmailService: preparing to send digest', {
    company: company.key,
    to,
    itemCount: items.length,
    smtpFrom: smtp.from,
  });

  const result = await getCompanyTransporter(company.key, smtp).sendMail({
    from: smtp.from,
    to,
    bcc: resolveBccRecipient(to),
    subject,
    html,
  });

  logger.info('digestEmailService: digest sent', {
    company: company.key,
    to,
    itemCount: items.length,
    messageId: result?.messageId || null,
  });

  return { messageId: result?.messageId || null };
}
