import express from 'express';
import logger from '../config/logger.js';
import { ApprovalService, ApprovalSapError, ApprovalUnauthorizedError } from '../services/sap/approvalService.js';
import {
  ACTIONS,
  TokenAlreadyUsedError,
  TokenExpiredError,
  TokenInvalidError,
  consumeToken,
  validateToken,
} from '../services/security/tokenService.js';

const router = express.Router();
const approvalService = new ApprovalService();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderDecisionPage({ action, payload, token, errorMessage = '' }) {
  const title = action === ACTIONS.APPROVE ? 'Approve Request' : 'Reject Request';
  const buttonLabel = action === ACTIONS.APPROVE ? 'Approve' : 'Reject';
  const buttonColor = action === ACTIONS.APPROVE ? '#1a7f37' : '#b42318';
  const approvalRequestId = escapeHtml(payload?.approvalRequestId);
  const approverUserId = escapeHtml(payload?.approverUserId);
  const stageId = escapeHtml(payload?.stageId);
  const remarksValue = '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin:0; font-family: Arial, Helvetica, sans-serif; background:#f4f5f7; color:#1f2937; }
    .wrap { max-width: 720px; margin: 0 auto; padding: 32px 16px; }
    .card { background:#fff; border-radius: 10px; box-shadow: 0 6px 24px rgba(15,23,42,.08); overflow:hidden; }
    .head { background:#1a2b4c; color:#fff; padding: 20px 28px; }
    .body { padding: 28px; }
    .meta { background:#f9fafb; border-radius: 8px; padding: 16px; margin: 18px 0 24px; }
    .meta div { display:flex; justify-content:space-between; gap:16px; padding: 6px 0; font-size: 14px; }
    label { display:block; font-weight:700; margin: 14px 0 8px; }
    input, textarea { width:100%; box-sizing:border-box; border:1px solid #d1d5db; border-radius:8px; padding:12px 14px; font-size:14px; }
    textarea { min-height: 120px; resize: vertical; }
    .actions { margin-top: 22px; display:flex; gap:12px; flex-wrap:wrap; }
    button { border:0; border-radius:8px; padding:12px 18px; font-size:14px; font-weight:700; color:#fff; cursor:pointer; }
    .secondary { background:#6b7280; text-decoration:none; display:inline-flex; align-items:center; }
    .notice { margin-top: 18px; padding: 12px 14px; border-radius:8px; background:${errorMessage ? '#fef2f2' : '#ecfdf5'}; color:${errorMessage ? '#991b1b' : '#065f46'}; }
    .small { color:#6b7280; font-size:12px; margin-top: 14px; line-height:1.5; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head"><strong>${escapeHtml(title)}</strong></div>
      <div class="body">
        <p>This approval link is tied to a single token and a single action.</p>
        <div class="meta">
          <div><span>Approval Request</span><strong>${approvalRequestId}</strong></div>
          <div><span>Approver User ID</span><strong>${approverUserId}</strong></div>
          <div><span>Stage ID</span><strong>${stageId}</strong></div>
          <div><span>Action</span><strong>${escapeHtml(action)}</strong></div>
        </div>

        ${errorMessage ? `<div class="notice">${escapeHtml(errorMessage)}</div>` : ''}

        <form method="post" action="/api/v1/${escapeHtml(action)}/${escapeHtml(token)}">
          <label for="username">SAP Username</label>
          <input id="username" name="username" autocomplete="username" required />

          <label for="password">SAP Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />

          <label for="remarks">Remarks</label>
          <textarea id="remarks" name="remarks" placeholder="Optional remarks...">${escapeHtml(remarksValue)}</textarea>

          <div class="actions">
            <button type="submit" style="background:${buttonColor};">${escapeHtml(buttonLabel)}</button>
            <a class="secondary" href="/api/v1/health">Cancel</a>
          </div>
        </form>

        <div class="small">
          If you were not expecting this email, you can ignore it. The token will expire automatically and cannot be reused once approved or rejected.
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function renderResultPage({ title, message, details = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin:0; font-family: Arial, Helvetica, sans-serif; background:#f4f5f7; color:#1f2937; }
    .wrap { max-width: 720px; margin: 0 auto; padding: 32px 16px; }
    .card { background:#fff; border-radius: 10px; box-shadow: 0 6px 24px rgba(15,23,42,.08); padding: 28px; }
    .ok { color:#065f46; background:#ecfdf5; padding:12px 14px; border-radius:8px; }
    .err { color:#991b1b; background:#fef2f2; padding:12px 14px; border-radius:8px; }
    .small { margin-top: 14px; color:#6b7280; font-size:12px; line-height:1.5; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${escapeHtml(title)}</h1>
      <div class="${title.toLowerCase().includes('error') ? 'err' : 'ok'}">${escapeHtml(message)}</div>
      ${details ? `<div class="small">${escapeHtml(details)}</div>` : ''}
    </div>
  </div>
</body>
</html>`;
}

function toHumanMessage(error) {
  if (error instanceof ApprovalUnauthorizedError) return 'You are not authorized to do this action.';
  if (error instanceof TokenExpiredError) return 'This approval link has expired.';
  if (error instanceof TokenAlreadyUsedError) return 'This approval link has already been used.';
  if (error instanceof TokenInvalidError) return error.message;
  if (error instanceof ApprovalSapError && error.meta?.friendlyMessage) {
    return error.meta.friendlyMessage;
  }
  if (error instanceof ApprovalSapError && error.meta?.cause) {
    return `${error.message} | SAP detail: ${typeof error.meta.cause === 'string' ? error.meta.cause : JSON.stringify(error.meta.cause)}`;
  }
  return error?.message || 'Unexpected error';
}

async function handleDecision(req, res, action) {
  const { token } = req.params;

  try {
    const payload = await validateToken(token);

    if (payload.action !== action) {
      return res.status(400).send(
        renderResultPage({
          title: 'Action Mismatch',
          message: 'This link was created for a different action.',
        })
      );
    }

    const isGet = req.method === 'GET';
    if (isGet) {
      return res.status(200).send(renderDecisionPage({ action, payload, token }));
    }

    const approvalRequestId = payload.approvalRequestId;
    const approverUserId = payload.approverUserId;
    const approverUsername = req.body?.username;
    const approverPassword = req.body?.password;
    const remarks = req.body?.remarks || '';

    const operation =
      action === ACTIONS.APPROVE
        ? approvalService.approveRequest(
            {
              approvalRequestId,
              approverUserId,
              approverUsername,
              approverPassword,
              remarks,
            },
            undefined,
            remarks
          )
        : approvalService.rejectRequest(
            {
              approvalRequestId,
              approverUserId,
              approverUsername,
              approverPassword,
              remarks,
            },
            undefined,
            remarks
          );

    const result = await operation;

    let consumeWarning = '';
    try {
      await consumeToken(payload.jti);
    } catch (consumeError) {
      logger.error('approval route: token consumption failed after successful SAP decision', {
        jti: payload.jti,
        approvalRequestId,
        error: consumeError?.message || String(consumeError),
      });
      consumeWarning = 'SAP action succeeded, but the token could not be marked as used. Please review the token store.';
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
        details: [
          `Current SAP status: ${result.currentStatus ?? 'unknown'}`,
          draftPostWarning,
          consumeWarning,
        ]
          .filter(Boolean)
          .join(' '),
      })
    );
  } catch (error) {
    if (error instanceof ApprovalSapError) {
      logger.error('approval route: SAP decision failed', {
        approvalRequestId: error.meta?.approvalRequestId,
        decisionStatus: error.meta?.decisionStatus,
        cause: error.meta?.cause,
        message: error.message,
      });
    }

    const status =
      error instanceof ApprovalUnauthorizedError
        ? 403
        : error instanceof TokenExpiredError || error instanceof TokenAlreadyUsedError
        ? 410
        : 400;
    return res.status(status).send(
      renderDecisionPage({
        action,
        payload: {},
        token,
        errorMessage: toHumanMessage(error),
      })
    );
  }
}

router.get('/approve/:token', (req, res) => handleDecision(req, res, ACTIONS.APPROVE));
router.get('/reject/:token', (req, res) => handleDecision(req, res, ACTIONS.REJECT));
router.post('/approve/:token', (req, res) => handleDecision(req, res, ACTIONS.APPROVE));
router.post('/reject/:token', (req, res) => handleDecision(req, res, ACTIONS.REJECT));

export default router;
