// Alert for a parked draft.
//
// A parked draft is one the app has stopped trying to post, because retrying
// would burn a SAP DocEntry on every attempt and could never succeed. That is
// the right call for the numbering, but it means the Sales Order silently does
// not exist until someone acts — so this email is not optional decoration, it
// is the safety net that makes parking safe.
//
// Delivery is deliberately NOT routed through approvalEmailService: this is an
// operational alert, not an approver email, so the EMAIL_MODE rollout
// allowlist, the digest allowlist and EMAIL_BCC must not redirect, copy or
// suppress it. It goes to DRAFT_POST_ALERT_TO and nowhere else.

import { config } from '../../config/index.js';
import logger from '../../config/logger.js';
import { currentCompany, currentCompanyHash } from '../company/companyContext.js';
import { getCompanyTransporter } from './mailer.js';
import { signDraftRetryToken } from '../../utils/draftRetryToken.js';
import { absoluteDraftRetryUrl } from '../../utils/appUrls.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml({ company, approvalRequestId, draftEntry, errorMessage, errorCode, classification, parkReason, retryUrl }) {
  const reasonLine =
    parkReason === 'permanent_failure'
      ? 'SAP rejected the document for a business reason. Retrying would not help until the cause is fixed.'
      : 'SAP kept failing with temporary errors and the retry budget is now spent.';

  return `
<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2933;max-width:640px">
  <h2 style="margin:0 0 4px;font-size:18px;color:#a61b1b">Sales Order draft could not be posted</h2>
  <p style="margin:0 0 16px;color:#52606d">Company <strong>${escapeHtml(company)}</strong></p>

  <p style="margin:0 0 16px">${escapeHtml(reasonLine)}</p>

  <p style="margin:0 0 16px;padding:12px;background:#fff4f4;border-left:3px solid #a61b1b">
    The approval went through, but <strong>no Sales Order exists yet</strong> for this draft.
    It will <strong>not</strong> be retried automatically.
  </p>

  <table style="border-collapse:collapse;margin:0 0 16px">
    <tr><td style="padding:4px 16px 4px 0;color:#52606d">Draft (DocEntry)</td><td style="padding:4px 0"><strong>${escapeHtml(draftEntry)}</strong></td></tr>
    <tr><td style="padding:4px 16px 4px 0;color:#52606d">Approval request</td><td style="padding:4px 0">${escapeHtml(approvalRequestId)}</td></tr>
    <tr><td style="padding:4px 16px 4px 0;color:#52606d">Classification</td><td style="padding:4px 0">${escapeHtml(classification)}</td></tr>
    ${errorCode ? `<tr><td style="padding:4px 16px 4px 0;color:#52606d">SAP code</td><td style="padding:4px 0">${escapeHtml(errorCode)}</td></tr>` : ''}
  </table>

  <p style="margin:0 0 6px;color:#52606d">SAP said:</p>
  <pre style="margin:0 0 20px;padding:12px;background:#f5f7fa;border-radius:4px;white-space:pre-wrap;font-size:12px">${escapeHtml(errorMessage)}</pre>

  <p style="margin:0 0 10px"><strong>What to do</strong></p>
  <ol style="margin:0 0 20px;padding-left:20px;color:#3e4c59">
    <li style="margin-bottom:4px">Open draft <strong>${escapeHtml(draftEntry)}</strong> in SAP and press Add to see the error in full.</li>
    <li style="margin-bottom:4px">Fix the cause (stock, credit limit, posting period, blocked item, price list).</li>
    <li>Then use the button below to let the app post it.</li>
  </ol>

  ${
    retryUrl
      ? `<a href="${escapeHtml(retryUrl)}" style="display:inline-block;padding:10px 20px;background:#1f6feb;color:#fff;text-decoration:none;border-radius:4px;font-weight:600">Retry this draft</a>
  <p style="margin:12px 0 0;font-size:12px;color:#7b8794">Only press this after the cause is fixed. Each attempt consumes one SAP DocEntry.</p>`
      : `<p style="margin:0;color:#7b8794;font-size:12px">Retry link unavailable (APP_BASE_URL is not configured) — post the draft manually in SAP.</p>`
  }
</div>`.trim();
}

/**
 * Send the parked-draft alert. Best-effort: a send failure is logged and
 * swallowed, because it must never turn into an approval or poll failure.
 *
 * @param {{approvalRequestId: string|number, draftEntry: string|number,
 *          errorMessage?: string, errorCode?: string, classification?: string,
 *          parkReason?: string}} info
 */
export async function sendParkedDraftAlert(info, { transporterFn = getCompanyTransporter } = {}) {
  const to = String(config.draftPost.alertTo || '').trim();
  if (!to) {
    logger.warn('draftPostAlert: DRAFT_POST_ALERT_TO is empty — parked draft not reported', {
      draftEntry: info?.draftEntry,
    });
    return { sent: false, reason: 'no_recipient' };
  }

  let company;
  try {
    company = currentCompany();
  } catch {
    logger.error('draftPostAlert: no company context; cannot send parked-draft alert', {
      draftEntry: info?.draftEntry,
    });
    return { sent: false, reason: 'no_company_context' };
  }

  const smtp = company.smtp;
  if (!smtp?.host || !smtp?.from) {
    logger.warn('draftPostAlert: SMTP not configured for company — parked draft not reported', {
      company: company.key,
      draftEntry: info?.draftEntry,
    });
    return { sent: false, reason: 'smtp_not_configured' };
  }

  let retryUrl = '';
  try {
    const token = signDraftRetryToken({
      approvalRequestId: info.approvalRequestId,
      draftEntry: info.draftEntry,
    });
    retryUrl = absoluteDraftRetryUrl(currentCompanyHash(), token);
  } catch (error) {
    logger.warn('draftPostAlert: could not build retry link', { error: error?.message || String(error) });
  }

  const html = buildHtml({
    company: company.key,
    approvalRequestId: info.approvalRequestId,
    draftEntry: info.draftEntry,
    errorMessage: info.errorMessage || 'No detail returned by SAP.',
    errorCode: info.errorCode || '',
    classification: info.classification || 'unknown',
    parkReason: info.parkReason || '',
    retryUrl,
  });

  try {
    const result = await transporterFn(company.key, smtp).sendMail({
      from: smtp.from,
      to, // DRAFT_POST_ALERT_TO only — no BCC, no allowlist redirection.
      subject: `[Action needed] Sales Order draft ${info.draftEntry} could not be posted (${company.key})`,
      html,
    });
    logger.info('draftPostAlert: parked-draft alert sent', {
      company: company.key,
      to,
      draftEntry: info.draftEntry,
      messageId: result?.messageId || null,
    });
    return { sent: true };
  } catch (error) {
    logger.error('draftPostAlert: failed to send parked-draft alert', {
      company: company.key,
      to,
      draftEntry: info.draftEntry,
      error: error?.message || String(error),
    });
    return { sent: false, reason: 'send_failed' };
  }
}

export default sendParkedDraftAlert;
