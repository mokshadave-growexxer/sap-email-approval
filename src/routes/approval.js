import express from 'express';
import logger from '../config/logger.js';
import { ApprovalService, ApprovalInvalidCredentialsError } from '../services/sap/approvalService.js';
import {
  GATE_FAILURE,
  consumeFootprintSession,
  getClientIp,
} from '../services/security/footprintService.js';
import {
  PROCESS_FAILURE,
  PROCESS_STATUS,
  getProcess,
  markProcessSuperseded,
} from '../services/approval/processStore.js';
import { logFailedDecision } from '../services/audit/decisionLogService.js';
import { executeDecision, DECISION_OUTCOME } from '../services/approval/decisionExecutor.js';
import { currentCompanyHash } from '../services/company/companyContext.js';
import { getApproverCredential, upsertApproverCredential } from '../services/security/userCredentialStore.js';
import {
  companyActionPath,
  companyFootprintClientPath,
  companyFootprintRegisterPath,
} from '../utils/appUrls.js';

const router = express.Router();
const approvalService = new ApprovalService();

const ACTIONS = Object.freeze({ APPROVE: 'approve', REJECT: 'reject' });

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderDecisionPage({ process, processId, companyHash, needsPassword = false, message = '', messageKind = 'error' }) {
  const title = 'Approval Decision';
  const approvalRequestId = escapeHtml(process?.approval_request_id);
  const level = escapeHtml(process?.level);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin:0; font-family: Arial, Helvetica, sans-serif; background:#f4f5f7; color:#1f2937; }
    .wrap { max-width: 560px; margin: 0 auto; padding: 40px 16px; }
    .card { background:#fff; border-radius: 12px; box-shadow: 0 8px 30px rgba(15,23,42,.10); overflow:hidden; }
    .head { background:#1a2b4c; color:#fff; padding: 22px 28px; font-size:18px; font-weight:700; }
    .body { padding: 28px; }
    .q { font-size:18px; font-weight:700; margin:0 0 6px; }
    .meta { background:#f9fafb; border-radius: 8px; padding: 14px 16px; margin: 18px 0; }
    .meta div { display:flex; justify-content:space-between; gap:16px; padding: 5px 0; font-size: 14px; }
    label { display:block; font-weight:700; margin: 14px 0 8px; font-size:14px; }
    textarea, input[type="password"], input[type="text"] { width:100%; box-sizing:border-box; border:1px solid #d1d5db; border-radius:8px; padding:12px 14px; font-size:14px; }
    textarea { min-height:84px; resize:vertical; }
    input[readonly] { background:#f3f4f6; color:#374151; cursor:not-allowed; }
    .status { display:flex; align-items:center; gap:10px; margin: 18px 0; padding:12px 14px; border-radius:8px; background:#f3f4f6; color:#374151; font-size:14px; }
    .status.ok { background:#ecfdf5; color:#065f46; }
    .status.err { background:#fef2f2; color:#991b1b; }
    .spinner { width:16px; height:16px; border:2px solid #cbd5e1; border-top-color:#1a2b4c; border-radius:50%; animation:spin .8s linear infinite; flex:0 0 auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .actions { margin-top: 8px; display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
    button { border:0; border-radius:8px; padding:13px 22px; font-size:15px; font-weight:700; color:#fff; cursor:pointer; }
    button[disabled] { opacity:.45; cursor:not-allowed; }
    .approve { background:#1a7f37; }
    .reject { background:#b42318; }
    #geo-retry { background:#374151; display:none; }
    .small { color:#6b7280; font-size:12px; margin-top: 16px; line-height:1.5; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head">${escapeHtml(title)}</div>
      <div class="body">
        <p class="q">Review this Sales Order, then Approve or Reject.</p>
        <div class="meta">
          <div><span>Approval Request</span><strong>${approvalRequestId}</strong></div>
          <div><span>Approval Level</span><strong>${level}</strong></div>
        </div>

        ${message ? `<div class="status ${messageKind === 'error' ? 'err' : ''}">${escapeHtml(message)}</div>` : ''}

        <form method="post" action="${escapeHtml(companyActionPath(companyHash, processId))}" data-process-id="${escapeHtml(processId)}" data-register-url="${escapeHtml(companyFootprintRegisterPath(companyHash))}" autocomplete="off">
          <input type="hidden" id="session_id" name="session_id" value="" />

          <label for="sap_user">SAP User ID</label>
          <input type="text" id="sap_user" value="${escapeHtml(process?.user_code)}" readonly tabindex="-1" aria-readonly="true" />
${
  needsPassword
    ? `
          <label for="sap_password">Enter your SAP password</label>
          <input type="password" id="sap_password" name="sap_password" autocomplete="off" autocapitalize="off" spellcheck="false" required placeholder="Your SAP password" />
`
    : ''
}
          <label for="remarks">Remarks (optional)</label>
          <textarea id="remarks" name="remarks" placeholder="Add a note for the audit trail..."></textarea>

          <div id="geo-status" class="status"><span class="spinner"></span><span id="geo-text">Verifying your device and location…</span></div>

          <div class="actions">
            <button class="decision-btn approve" type="submit" name="decision" value="approve" disabled>Approve</button>
            <button class="decision-btn reject" type="submit" name="decision" value="reject" disabled>Reject</button>
            <button id="geo-retry" type="button">Retry</button>
          </div>
        </form>

        <div class="small">
          ${
            needsPassword
              ? 'Enter your SAP password once to authorize this decision. It is stored securely (encrypted) and used only to submit your approvals to SAP — you won’t be asked again unless your SAP password changes. Your device and location are recorded for the audit trail.'
              : 'Choose Approve or Reject. Your decision is submitted to SAP under your SAP user. Your device and location are recorded for the audit trail.'
          }
        </div>
      </div>
    </div>
  </div>
  <script src="${escapeHtml(companyFootprintClientPath(companyHash))}"></script>
</body>
</html>`;
}

function renderResultPage({ title, message, details = '' }) {
  const isError = /error|required|expired|invalid|denied/i.test(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin:0; font-family: Arial, Helvetica, sans-serif; background:#f4f5f7; color:#1f2937; }
    .wrap { max-width: 560px; margin: 0 auto; padding: 48px 16px; }
    .card { background:#fff; border-radius: 12px; box-shadow: 0 8px 30px rgba(15,23,42,.10); padding: 32px; }
    h1 { margin:0 0 16px; font-size:20px; }
    .ok { color:#065f46; background:#ecfdf5; padding:14px 16px; border-radius:8px; }
    .err { color:#991b1b; background:#fef2f2; padding:14px 16px; border-radius:8px; }
    .small { margin-top: 16px; color:#6b7280; font-size:12px; line-height:1.5; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${escapeHtml(title)}</h1>
      <div class="${isError ? 'err' : 'ok'}">${escapeHtml(message)}</div>
      ${details ? `<div class="small">${escapeHtml(details)}</div>` : ''}
    </div>
  </div>
</body>
</html>`;
}

const FAILURE_MESSAGES = Object.freeze({
  [GATE_FAILURE.NO_SESSION]:
    'Location verification is required before you can decide. Please reopen the link and allow location access.',
  [GATE_FAILURE.GEO_DENIED]:
    'Location access was denied. Please enable location permissions, reload the link, and try again.',
  [GATE_FAILURE.ALREADY_CONSUMED]:
    'This link has already been submitted. If you need to make a change, contact your SAP administrator.',
  [GATE_FAILURE.EXPIRED]:
    'Your verification window has expired. Please reopen the link and allow location access again.',
  [PROCESS_FAILURE.NOT_FOUND]: 'This approval link is invalid.',
  [PROCESS_FAILURE.EXPIRED]: 'This approval link has expired.',
  [PROCESS_FAILURE.ALREADY_DECIDED]: 'This request has already been decided.',
});

function failureMessage(reason) {
  return FAILURE_MESSAGES[reason] || 'This decision could not be verified. Please reopen the link and try again.';
}

const ALREADY_DECIDED_PAGE = Object.freeze({
  title: 'Link No Longer Active',
  message:
    'This approval link is no longer active — the request was already decided, or the document was changed and a new approval was generated. Please use the most recent approval email.',
});

const DOCUMENT_LOCKED_PAGE = Object.freeze({
  title: 'Document In Use',
  message: 'This document is currently being edited by another user. Please try again in a little while.',
});

// Ask SAP (the source of truth) whether this approver may still act on the exact
// stage this link was issued for. A decision taken in the SAP add-on retires the
// link here even though this service never processed it. Best-effort: a failed
// SAP read defers to the authoritative guard inside ApprovalService._decide.
async function confirmStillActionableInSap(process) {
  try {
    return await approvalService.getDecisionEligibility({
      approvalRequestId: process.approval_request_id,
      approverUserId: process.sap_user_id,
      stage: process.stage,
    });
  } catch (error) {
    logger.warn('approval route: SAP eligibility check failed; deferring to decision-time guard', {
      processId: process.id,
      error: error?.message || String(error),
    });
    return null;
  }
}

async function handleAction(req, res) {
  // The decision page can carry a SAP password field — never let it be cached.
  res.set('Cache-Control', 'no-store');
  const { processId } = req.params;
  const process = await getProcess(processId);

  if (!process) {
    return res.status(404).send(
      renderResultPage({ title: 'Invalid Link', message: 'This approval link is invalid or no longer exists.' })
    );
  }

  // Refuse an already-decided link before any footprint work. Links never expire
  // by time; only a decision or a supersession retires them.
  if (process.status !== PROCESS_STATUS.PENDING) {
    return res.status(410).send(
      renderResultPage({
        title: 'Link No Longer Active',
        message:
          process.status === PROCESS_STATUS.SUPERSEDED
            ? ALREADY_DECIDED_PAGE.message
            : 'This request has already been decided.',
      })
    );
  }

  // Retire links whose stage was already decided in SAP (add-on), for both the
  // page view and the decision submit.
  const eligibility = await confirmStillActionableInSap(process);
  if (eligibility && !eligibility.actionable) {
    await markProcessSuperseded(processId, eligibility.reason);
    logger.info('approval route: link retired; stage already decided in SAP', {
      processId,
      reason: eligibility.reason,
      currentStage: eligibility.currentStage,
    });
    return res.status(410).send(renderResultPage(ALREADY_DECIDED_PAGE));
  }

  if (req.method === 'GET') {
    return res.status(200).send(renderDecisionPage({ process, processId, companyHash: currentCompanyHash() }));
  }

  // The chosen action comes from which button was clicked (decision = approve|reject).
  const decision = req.body?.decision;
  const action = decision === ACTIONS.APPROVE || decision === ACTIONS.REJECT ? decision : null;
  if (!action) {
    return res.status(400).send(
      renderDecisionPage({
        process,
        processId,
        companyHash: currentCompanyHash(),
        message: 'Please choose Approve or Reject.',
      })
    );
  }

  return handleDecisionPost(req, res, action, processId, process);
}

async function handleDecisionPost(req, res, action, processId, process) {
  const postIp = getClientIp(req);
  const sessionId = req.body?.session_id;
  const remarks = req.body?.remarks || '';
  const companyHash = currentCompanyHash();

  const auditFailure = (failureReason) => logFailedDecision({ processId, failureReason });

  // Resolve the approver's SAP password before touching the process. On the happy
  // path it comes from the encrypted store; only first-time enrollment or a
  // changed password requires typing it. Resolving first means a not-yet-enrolled
  // approver is prompted without consuming their location capture or claiming the
  // process. Passwords are never logged and never echoed back.
  const typedPassword = req.body?.sap_password || '';
  const enrollOnSuccess = Boolean(typedPassword);
  let effectivePassword = typedPassword;

  if (!typedPassword) {
    const credential = await getApproverCredential(process.user_code);
    if (!credential.found) {
      return res.status(200).send(
        renderDecisionPage({
          process,
          processId,
          companyHash,
          needsPassword: true,
          messageKind: 'info',
          message:
            'First time here — please enter your SAP password once to authorize this decision. You won’t be asked again unless your SAP password changes.',
        })
      );
    }
    effectivePassword = credential.password;
  }

  // Footprint gate (the location/device boundary) — verified in the DB, not the button.
  const gate = await consumeFootprintSession({ sessionId, processId });
  if (!gate.ok) {
    await auditFailure(gate.reason);
    logger.warn('approval route: footprint gate rejected decision', { processId, reason: gate.reason });
    return res.status(403).send(
      renderResultPage({ title: 'Verification Required', message: failureMessage(gate.reason) })
    );
  }
  const session = gate.session;

  if (session.ip_address && postIp && session.ip_address !== postIp) {
    logger.info('approval route: IP differs between footprint capture and decision', {
      processId,
      footprintIp: session.ip_address,
      postIp,
    });
  }

  // The single decision goes through the same executor the bulk digest uses, so
  // both paths share identical SAP claim/decide/verify/post-draft semantics.
  let outcome;
  try {
    outcome = await executeDecision({ process, action, effectivePassword, remarks, footprintSession: session });
  } catch (error) {
    // SAP rejected the password. Re-prompt: a wrong typed password just retries;
    // a rejected stored password means it changed, so re-enroll. (The executor
    // has already released the process.)
    if (error instanceof ApprovalInvalidCredentialsError) {
      logger.info('approval route: SAP rejected approver credentials — re-prompting', { processId, wasStored: !enrollOnSuccess });
      return res.status(200).send(
        renderDecisionPage({
          process,
          processId,
          companyHash,
          needsPassword: true,
          messageKind: enrollOnSuccess ? 'error' : 'info',
          message: enrollOnSuccess
            ? 'That SAP password was not accepted. Please check it and try again.'
            : 'Your SAP password may have changed. Please enter your current SAP password once to continue.',
        })
      );
    }
    throw error;
  }

  switch (outcome.outcome) {
    case DECISION_OUTCOME.CLAIM_FAILED:
      await auditFailure(outcome.reason);
      logger.warn('approval route: process claim rejected decision', { processId, reason: outcome.reason });
      return res.status(410).send(
        renderResultPage({ title: 'Link No Longer Active', message: failureMessage(outcome.reason) })
      );
    case DECISION_OUTCOME.LOCKED:
      logger.info('approval route: decision blocked by document lock', { processId });
      return res.status(409).send(renderResultPage(DOCUMENT_LOCKED_PAGE));
    case DECISION_OUTCOME.SUPERSEDED:
      logger.info('approval route: decision superseded by SAP add-on', { processId, reason: outcome.reason });
      return res.status(410).send(renderResultPage(ALREADY_DECIDED_PAGE));
    case DECISION_OUTCOME.FAILED:
      return res.status(outcome.unauthorized ? 403 : 400).send(
        renderDecisionPage({ process, processId, companyHash, message: outcome.message })
      );
    default:
      break;
  }

  // A freshly typed password that worked — remember it (encrypted) so this
  // approver won't be asked again. A storage failure must never undo the approval
  // that already succeeded in SAP.
  if (enrollOnSuccess) {
    try {
      await upsertApproverCredential(process.user_code, typedPassword);
    } catch (storeError) {
      logger.error('approval route: approval succeeded but storing the credential failed', {
        processId,
        userCode: process.user_code,
        error: storeError?.message || String(storeError),
      });
    }
  }

  return res.status(200).send(
    renderResultPage({
      title: action === ACTIONS.APPROVE ? 'Approval Completed' : 'Rejection Completed',
      message: `Request ${outcome.approvalRequestId} was processed successfully.`,
      details: [`Current SAP status: ${outcome.currentStatus ?? 'unknown'}`, outcome.draftPostWarning]
        .filter(Boolean)
        .join(' '),
    })
  );
}

// Single "Take Action" entry point: GET renders the page (Approve + Reject
// buttons); POST carries the chosen decision (approve|reject) from the button.
router.get('/action/:processId', (req, res) => handleAction(req, res));
router.post('/action/:processId', (req, res) => handleAction(req, res));

export { renderDecisionPage };
export default router;
