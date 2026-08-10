import express from 'express';
import logger from '../config/logger.js';
import {
  ApprovalService,
  ApprovalDocumentLockedError,
  ApprovalSapError,
  ApprovalStageAdvancedError,
  ApprovalUnauthorizedError,
} from '../services/sap/approvalService.js';
import {
  GATE_FAILURE,
  consumeFootprintSession,
  getClientIp,
} from '../services/security/footprintService.js';
import {
  PROCESS_FAILURE,
  PROCESS_STATUS,
  claimProcess,
  getProcess,
  markProcessDecided,
  markProcessSuperseded,
  releaseProcess,
} from '../services/approval/processStore.js';
import {
  createPendingDecision,
  logFailedDecision,
  markDecisionFailed,
  markDecisionSuccess,
} from '../services/audit/decisionLogService.js';
import { scheduleFinalDocReconciliation } from '../services/audit/finalDocReconciler.js';
import { writeDecisionRemark } from '../services/sap/decisionRemarkStore.js';
import { linkApprovalFootprintsToDocument } from '../services/sap/footprintDocumentLinker.js';
import { getSalesOrderChangeStatus } from '../services/sap/draftStatusService.js';
import { currentCompany, currentCompanyHash } from '../services/company/companyContext.js';
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

function renderDecisionPage({ process, processId, companyHash, errorMessage = '' }) {
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

        ${errorMessage ? `<div class="status err">${escapeHtml(errorMessage)}</div>` : ''}

        <form method="post" action="${escapeHtml(companyActionPath(companyHash, processId))}" data-process-id="${escapeHtml(processId)}" data-register-url="${escapeHtml(companyFootprintRegisterPath(companyHash))}" autocomplete="off">
          <input type="hidden" id="session_id" name="session_id" value="" />

          <label for="sap_user">SAP User ID</label>
          <input type="text" id="sap_user" value="${escapeHtml(process?.user_code)}" readonly tabindex="-1" aria-readonly="true" />

          <label for="sap_password">Please enter your SAP password</label>
          <input type="password" id="sap_password" name="sap_password" autocomplete="off" autocapitalize="off" spellcheck="false" required placeholder="Your SAP password" />

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
          Enter your SAP password, then choose Approve or Reject. The password is verified directly by SAP and is never stored. Your device fingerprint is recorded for the audit trail. This link works once and expires automatically.
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

function toHumanMessage(error) {
  if (error instanceof ApprovalUnauthorizedError) return 'You are not authorized to approve or reject this request.';
  if (error instanceof ApprovalSapError && error.meta?.friendlyMessage) return error.meta.friendlyMessage;
  // Never surface raw SAP/internal error detail to the browser.
  return 'Your SAP password could not be verified, or the decision could not be completed. Please check your password and try again.';
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

function linkTimestamps(process) {
  return { linkSentAt: process?.sent_at ?? null, linkExpiry: process?.expires_at ?? null };
}

function buildSapResponseForLog(error) {
  if (error instanceof ApprovalSapError) {
    return { message: error.message, code: error.code ?? null, meta: error.meta ?? null };
  }
  return { message: error?.message || String(error) };
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
  // The decision page carries a SAP password field — never let it be cached.
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
        errorMessage: 'Please choose Approve or Reject.',
      })
    );
  }

  return handleDecisionPost(req, res, action, processId, process);
}

async function handleDecisionPost(req, res, action, processId, process) {
  const sessionId = req.body?.session_id;
  const postIp = getClientIp(req);
  const userAgent = req.headers['user-agent'] || null;
  const { linkSentAt, linkExpiry } = linkTimestamps(process);

  const auditFailure = (failureReason, footprintSessionId = null) =>
    logFailedDecision({
      processId,
      approvalRequestId: process.approval_request_id,
      action,
      approverUserId: process.sap_user_id,
      userCode: process.user_code,
      postIpAddress: postIp,
      userAgent,
      linkSentAt,
      linkExpiry,
      footprintSessionId,
      failureReason,
    });

  // Footprint gate (the location/device boundary) — verified in the DB, not the button.
  const gate = await consumeFootprintSession({ sessionId, processId });
  if (!gate.ok) {
    await auditFailure(gate.reason, sessionId || null);
    logger.warn('approval route: footprint gate rejected decision', { processId, reason: gate.reason });
    return res.status(403).send(
      renderResultPage({ title: 'Verification Required', message: failureMessage(gate.reason) })
    );
  }
  const session = gate.session;

  // Claim the process (one-time + expiry), race-safe.
  const claim = await claimProcess(processId);
  if (!claim.ok) {
    await auditFailure(claim.reason, session.session_id);
    logger.warn('approval route: process claim rejected decision', { processId, reason: claim.reason });
    return res.status(410).send(
      renderResultPage({ title: 'Link No Longer Active', message: failureMessage(claim.reason) })
    );
  }

  if (session.ip_address && postIp && session.ip_address !== postIp) {
    logger.info('approval route: IP differs between footprint capture and decision', {
      processId,
      footprintIp: session.ip_address,
      postIp,
    });
  }

  const { id: decisionLogId } = await createPendingDecision({
    processId,
    approvalRequestId: process.approval_request_id,
    action,
    approverUserId: process.sap_user_id,
    userCode: process.user_code,
    approverEmail: process.approver_email,
    session,
    postIpAddress: postIp,
    linkSentAt,
    linkExpiry,
  });

  // The approver's SAP password is typed on the decision page and used only to
  // authenticate this one decision against SAP. It is never stored, never
  // logged, and never echoed back. `sapPassword` is intentionally NOT spread
  // into any log object below.
  const sapPassword = req.body?.sap_password || '';
  if (!sapPassword) {
    await releaseProcess(processId);
    await markDecisionFailed(decisionLogId, 'sap_password_missing');
    return res.status(400).send(
      renderDecisionPage({
        process,
        processId,
        companyHash: currentCompanyHash(),
        errorMessage: 'Please enter your SAP password.',
      })
    );
  }

  let result;
  try {
    const params = {
      approvalRequestId: process.approval_request_id,
      approverUserId: process.sap_user_id,
      approverUsername: process.user_code,
      approverPassword: sapPassword,
      expectedStage: process.stage,
      remarks: req.body?.remarks || '',
    };

    result =
      action === ACTIONS.APPROVE
        ? await approvalService.approveRequest(params, undefined, params.remarks)
        : await approvalService.rejectRequest(params, undefined, params.remarks);
  } catch (error) {
    // A concurrent edit holds the document open in SAP. Keep the link usable and
    // ask the approver to retry once the editor is done.
    if (error instanceof ApprovalDocumentLockedError) {
      await releaseProcess(processId);
      await markDecisionFailed(decisionLogId, 'document_locked');
      logger.info('approval route: decision blocked by document lock', { processId });
      return res.status(409).send(renderResultPage(DOCUMENT_LOCKED_PAGE));
    }

    // The stage was decided in SAP (add-on) between page load and submit —
    // retire the link rather than releasing it for another attempt.
    if (error instanceof ApprovalStageAdvancedError) {
      await markProcessSuperseded(processId, error.meta?.reason || 'stage_advanced');
      await markDecisionFailed(decisionLogId, `superseded:${error.meta?.reason || 'stage_advanced'}`);
      logger.info('approval route: decision superseded by SAP add-on', {
        processId,
        reason: error.meta?.reason,
        currentStage: error.meta?.currentStage,
      });
      return res.status(410).send(renderResultPage(ALREADY_DECIDED_PAGE));
    }

    if (error instanceof ApprovalSapError) {
      logger.error('approval route: SAP decision failed', {
        approvalRequestId: error.meta?.approvalRequestId,
        decisionStatus: error.meta?.decisionStatus,
        cause: error.meta?.cause,
        message: error.message,
      });
    }

    await releaseProcess(processId);
    await markDecisionFailed(decisionLogId, error?.message || String(error), buildSapResponseForLog(error));

    const status = error instanceof ApprovalUnauthorizedError ? 403 : 400;
    return res.status(status).send(
      renderDecisionPage({ process, processId, companyHash: currentCompanyHash(), errorMessage: toHumanMessage(error) })
    );
  }

  await markProcessDecided(processId, action);

  const after = result?.sapResponse?.after;
  const draftDocEntry = after?.DraftEntry ?? result?.draftPost?.draftEntry ?? process.draft_entry ?? null;
  // The final Sales Order DocEntry is either returned by SaveDraftToDocument, or
  // exposed as the ApprovalRequest's ObjectEntry once IsDraft flips to 'N'.
  const draftPostFinal = result?.draftPost?.success
    ? result.draftPost.result?.DocEntry ?? result.draftPost.result?.docEntry ?? null
    : null;
  const objectEntryFinal = after && String(after.IsDraft) === 'N' && Number(after.ObjectEntry) > 0
    ? Number(after.ObjectEntry)
    : null;
  const syncFinalDocEntry = draftPostFinal ?? objectEntryFinal;

  await markDecisionSuccess(decisionLogId, {
    sapResponse: result?.sapResponse ?? null,
    timezone: session.timezone,
    draftDocEntry,
    finalDocEntry: syncFinalDocEntry,
  });

  // Surface the approver's remark in SAP's Approval Status Report (WDD1.Remarks).
  // The Service Layer writes it only intermittently, so it is written directly
  // and deterministically here for this approver's line.
  const remarkText = (req.body?.remarks || '').trim();
  if (remarkText) {
    await writeDecisionRemark({
      approvalRequestId: process.approval_request_id,
      sapUserId: process.sap_user_id,
      remark: remarkText,
    });
  }

  // Once the FINAL level approves and the draft becomes a Sales Order, record on
  // each of this request's footprints which document it belongs to (DocEntry +
  // DocNum) and whether that document was newly CREATED or an existing one
  // UPDATED. The CREATED/UPDATED signal must be read from the pre-decision
  // snapshot: after conversion SAP sets ObjectEntry for new orders too, so it no
  // longer distinguishes the two.
  const changeType = getSalesOrderChangeStatus(result?.sapResponse?.before).code;

  if (action === ACTIONS.APPROVE && result?.currentStatus === 'arsApproved') {
    if (syncFinalDocEntry != null) {
      linkApprovalFootprintsToDocument({
        approvalRequestId: process.approval_request_id,
        docEntry: syncFinalDocEntry,
        changeType,
      }).catch(() => {});
    } else {
      // Vendor add-on converts a few seconds later — fill final_doc_entry from the
      // ApprovalRequest's ObjectEntry once it appears, and link the footprints then.
      scheduleFinalDocReconciliation({
        decisionLogId,
        approvalRequestId: process.approval_request_id,
        draftDocEntry,
        company: currentCompany(),
        onResolved: (docEntry) =>
          linkApprovalFootprintsToDocument({
            approvalRequestId: process.approval_request_id,
            docEntry,
            changeType,
          }),
      });
    }
  }

  const draftPostWarning =
    result?.draftPost?.attempted && result.draftPost.success === false
      ? result.draftPost.error ||
        'Approval succeeded, but the approved draft could not be posted. Manual or automatic retry is required.'
      : '';

  return res.status(200).send(
    renderResultPage({
      title: action === ACTIONS.APPROVE ? 'Approval Completed' : 'Rejection Completed',
      message: `Request ${result.approvalRequestId} was processed successfully.`,
      details: [`Current SAP status: ${result.currentStatus ?? 'unknown'}`, draftPostWarning].filter(Boolean).join(' '),
    })
  );
}

// Single "Take Action" entry point: GET renders the page (Approve + Reject
// buttons); POST carries the chosen decision (approve|reject) from the button.
router.get('/action/:processId', (req, res) => handleAction(req, res));
router.post('/action/:processId', (req, res) => handleAction(req, res));

export default router;
