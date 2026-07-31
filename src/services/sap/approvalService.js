import { currentSL } from '../company/companyContext.js';
import logger from '../../config/logger.js';

export const STATUS = Object.freeze({
  APPROVE: 'ardApproved',
  REJECT: 'ardNotApproved',
});

export class ApprovalError extends Error {
  constructor(message, code, meta = {}) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    this.meta = meta;
  }
}

export class ApprovalNotPendingError extends ApprovalError {
  constructor(approvalRequestId, actualStatus) {
    super(`ApprovalRequest ${approvalRequestId} is not pending (status: ${actualStatus})`, 'NOT_PENDING', {
      approvalRequestId,
      actualStatus,
    });
    this.name = 'ApprovalNotPendingError';
  }
}

export class ApprovalVerificationError extends ApprovalError {
  constructor(approvalRequestId, approverUserId, expectedStatus) {
    super(
      `PATCH succeeded but ApprovalRequest ${approvalRequestId} did not reflect '${expectedStatus}' for approver ${approverUserId} on re-check.`,
      'VERIFICATION_FAILED',
      { approvalRequestId, approverUserId, expectedStatus }
    );
    this.name = 'ApprovalVerificationError';
  }
}

export class ApprovalUnauthorizedError extends ApprovalError {
  constructor(approvalRequestId, approverUserId) {
    super(
      `You are not authorized to approve or reject ApprovalRequest ${approvalRequestId} for approver ${approverUserId}.`,
      'UNAUTHORIZED_APPROVER',
      { approvalRequestId, approverUserId }
    );
    this.name = 'ApprovalUnauthorizedError';
  }
}

export class ApprovalSapError extends ApprovalError {
  constructor(message, meta = {}) {
    super(message, 'SAP_ERROR', meta);
    this.name = 'ApprovalSapError';
  }
}

function stringifySapErrorDetail(detail) {
  if (detail == null) {
    return 'Unknown SAP error';
  }

  if (typeof detail === 'string') {
    return detail;
  }

  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/**
 * Clone an ApprovalRequest PATCH body for logging with ApproverPassword redacted.
 *
 * @param {object} body - Original PATCH payload (unchanged for the live SAP call).
 * @returns {object} Shallow clone safe to log.
 */
export function redactApprovalDecisionBodyForLog(body) {
  if (!body || typeof body !== 'object') {
    return body;
  }

  const decisions = Array.isArray(body.ApprovalRequestDecisions)
    ? body.ApprovalRequestDecisions.map((decision) => ({
        ...decision,
        ApproverPassword: decision?.ApproverPassword != null ? '***' : decision?.ApproverPassword,
      }))
    : body.ApprovalRequestDecisions;

  return {
    ...body,
    ApprovalRequestDecisions: decisions,
  };
}

function extractSapFailureMeta(error) {
  const status = error?.response?.status ?? null;
  const responseData = error?.response?.data;
  const messageValue = responseData?.error?.message?.value ?? responseData?.message?.value;
  const errorCode = responseData?.error?.code ?? responseData?.code ?? '';
  const rawDetail = responseData ?? error?.message ?? 'Unknown SAP error';
  const sapErrorDetail = messageValue || rawDetail;
  const normalizedDetail = typeof sapErrorDetail === 'string' ? sapErrorDetail.toLowerCase() : '';

  let friendlyMessage = 'SAP rejected the request.';

  if (
    errorCode === '-8023' ||
    status === 401 ||
    status === 403 ||
    /unauthori[sz]ed|invalid credentials|login failed|authentication|user code or password is incorrect/i.test(normalizedDetail)
  ) {
    friendlyMessage = 'Please check your username and password. If they are correct, you are not authorized to approve/reject this request.';
  } else if (/not authorized|permission|forbidden/i.test(normalizedDetail)) {
    friendlyMessage = 'Please check your username and password. If they are correct, you are not authorized to approve/reject this request.';
  } else if (/session|login/i.test(normalizedDetail)) {
    friendlyMessage = 'SAP session expired. Please try again.';
  }

  return {
    status,
    sapErrorDetail,
    friendlyMessage,
  };
}

/**
 * Convert an approved draft sales order into a posted document via SAP DraftsService.
 *
 * @param {{ client: { post: Function }, ensureLoggedIn?: Function }} sessionManager - SAP session manager with an axios-like client.
 * @param {string|number} draftEntry - Draft DocEntry from the ApprovalRequest.
 * @returns {Promise<object>} Newly created Sales Order payload from SAP.
 */
export async function postApprovedDraft(sessionManager, draftEntry) {
  if (draftEntry === undefined || draftEntry === null || draftEntry === '') {
    throw new ApprovalError('draftEntry is required to post an approved draft.', 'INVALID_INPUT', {
      draftEntry,
    });
  }

  const path = '/DraftsService_SaveDraftToDocument';
  const body = { Document: { DocEntry: String(draftEntry) } };

  logger.info('postApprovedDraft: SaveDraftToDocument request', {
    draftEntry: String(draftEntry),
    url: path,
    body,
  });

  try {
    if (typeof sessionManager?.ensureLoggedIn === 'function') {
      await sessionManager.ensureLoggedIn();
    }

    const response = await sessionManager.client.post(path, body);
    logger.info('postApprovedDraft: SaveDraftToDocument response', {
      draftEntry: String(draftEntry),
      status: response?.status ?? null,
      data: response?.data ?? null,
    });
    return response?.data ?? response;
  } catch (error) {
    const { status, sapErrorDetail, friendlyMessage } = extractSapFailureMeta(error);
    logger.error('postApprovedDraft: SaveDraftToDocument failed', {
      draftEntry: String(draftEntry),
      url: path,
      body,
      status,
      sapErrorDetail,
    });
    throw new ApprovalSapError(
      `${friendlyMessage} SaveDraftToDocument failed for DraftEntry ${draftEntry}: ${stringifySapErrorDetail(sapErrorDetail)}`,
      {
        draftEntry: String(draftEntry),
        cause: sapErrorDetail,
        status,
        friendlyMessage,
      }
    );
  }
}

export class ApprovalService {
  constructor(sessionManager = null) {
    this._sessionManager = sessionManager;
  }

  // The active company's Service Layer session, unless a manager was injected
  // (tests). Resolved per call so one service instance serves every company.
  get sessionManager() {
    return this._sessionManager ?? currentSL();
  }

  /**
   * Post an approved draft sales order using this service's session manager.
   *
   * @param {string|number} draftEntry - Draft DocEntry from the ApprovalRequest.
   * @returns {Promise<object>} Newly created Sales Order payload from SAP.
   */
  async postApprovedDraft(draftEntry) {
    return postApprovedDraft(this.sessionManager, draftEntry);
  }

  async approveRequest(input, approver, remarks) {
    const params = this._normalizeDecisionInput(input, approver, remarks);
    return this._decide({
      approvalRequestId: params.approvalRequestId,
      approverUserId: params.approverUserId,
      approverUsername: params.approverUsername,
      approverPassword: params.approverPassword,
      remarks: params.remarks,
      decisionStatus: STATUS.APPROVE,
    });
  }

  async rejectRequest(input, approver, remarks) {
    const params = this._normalizeDecisionInput(input, approver, remarks);
    return this._decide({
      approvalRequestId: params.approvalRequestId,
      approverUserId: params.approverUserId,
      approverUsername: params.approverUsername,
      approverPassword: params.approverPassword,
      remarks: params.remarks,
      decisionStatus: STATUS.REJECT,
    });
  }

  async _decide({ approvalRequestId, decisionStatus, approverUserId, approverUsername, approverPassword, remarks }) {
    const requestId = this._normalizeApprovalRequestId(approvalRequestId);
    const normalizedUserId = this._normalizeApproverUserId(approverUserId);

    if (!requestId) {
      throw new ApprovalError('approvalRequestId is required.', 'INVALID_INPUT');
    }

    if (!approverUsername || !approverPassword) {
      throw new ApprovalError('approver credentials must include username and password.', 'INVALID_INPUT');
    }

    logger.info('ApprovalService.decide: start', { approvalRequestId: requestId, decisionStatus, approverUserId: normalizedUserId });

    const before = await this._executeWithSessionRecovery(() => this._getApprovalRequest(requestId), { approvalRequestId: requestId, action: 'GET' });
    if (before?.Status !== 'arsPending') {
      throw new ApprovalNotPendingError(requestId, before?.Status ?? 'unknown');
    }

    const approverLineBefore = this._findApproverLine(before, normalizedUserId);
    if (!approverLineBefore) {
      throw new ApprovalUnauthorizedError(requestId, normalizedUserId);
    }

    const body = {
      ApprovalRequestDecisions: [
        {
          Status: decisionStatus,
          ApproverUserName: approverUsername,
          ApproverPassword: approverPassword,
          Remarks: remarks || '',
        },
      ],
    };

    const patchUrl = `/ApprovalRequests(${encodeURIComponent(requestId)})`;
    logger.info('ApprovalService.decide: patch request', {
      approvalRequestId: requestId,
      approverUserId: normalizedUserId,
      url: patchUrl,
      body: redactApprovalDecisionBodyForLog(body),
    });

    let patchResponse;
    try {
      patchResponse = await this._executeWithSessionRecovery(() => this._patchApprovalRequest(requestId, body), {
        approvalRequestId: requestId,
        action: 'PATCH',
        decisionStatus,
      });
    } catch (err) {
      const { status, sapErrorDetail, friendlyMessage } = extractSapFailureMeta(err);
      logger.error('ApprovalService: PATCH failed', {
        approvalRequestId: requestId,
        decisionStatus,
        status,
        sapErrorDetail,
      });
      throw new ApprovalSapError(
        `${friendlyMessage} PATCH failed for ApprovalRequest ${requestId}: ${stringifySapErrorDetail(sapErrorDetail)}`,
        {
          approvalRequestId: requestId,
          decisionStatus,
          cause: sapErrorDetail,
          status,
          friendlyMessage,
        }
      );
    }

    logger.info('ApprovalService.decide: patch response', {
      approvalRequestId: requestId,
      status: patchResponse?.status ?? null,
    });

    const afterSelect =
      '$select=Status,CurrentStage,ObjectType,IsDraft,DraftEntry,ObjectEntry,ApprovalRequestLines';
    const after = await this._executeWithSessionRecovery(
      () => this._getApprovalRequest(requestId, afterSelect),
      {
        approvalRequestId: requestId,
        action: 'GET_AFTER_PATCH',
      }
    );

    logger.info('ApprovalService.decide: re-fetched approval request after patch', {
      approvalRequestId: requestId,
      status: after?.Status ?? null,
      objectType: after?.ObjectType ?? null,
      isDraft: after?.IsDraft ?? null,
      draftEntry: after?.DraftEntry ?? null,
      objectEntry: after?.ObjectEntry ?? null,
      approvalRequestLines: after?.ApprovalRequestLines ?? [],
    });

    const approverLine = this._findApproverLine(after, normalizedUserId);
    const lineConfirmed = Boolean(approverLine && approverLine.Status === decisionStatus);
    const overallConfirmed = after?.Status !== 'arsPending';

    if (!lineConfirmed) {
      throw new ApprovalVerificationError(requestId, normalizedUserId, decisionStatus);
    }

    logger.info('ApprovalService.decide: verified', {
      approvalRequestId: requestId,
      decisionStatus,
      approverUserId: normalizedUserId,
      overallStatus: after?.Status,
      overallConfirmed,
    });

    const draftPost = await this._maybePostApprovedDraftAfterDecision({
      approvalRequestId: requestId,
      after,
      overallConfirmed,
    });

    return {
      success: true,
      approvalRequestId: requestId,
      previousStatus: before?.Status ?? null,
      currentStatus: after?.Status ?? null,
      draftPost,
      sapResponse: {
        before,
        patchBody: body,
        after,
      },
    };
  }

  /**
   * After a verified approval decision, post draft sales orders when applicable.
   * Approval success is never rolled back if SaveDraftToDocument fails.
   *
   * @param {{ approvalRequestId: string, after: object, overallConfirmed: boolean }} params
   * @returns {Promise<object|null>} Draft-post outcome, or null when not attempted.
   */
  async _maybePostApprovedDraftAfterDecision({ approvalRequestId, after, overallConfirmed }) {
    const overallStatus = after?.Status ?? null;
    if (overallStatus !== 'arsApproved' || !overallConfirmed) {
      return null;
    }

    const objectType = after?.ObjectType != null ? String(after.ObjectType) : '';
    const isDraft = after?.IsDraft;
    const draftEntry = after?.DraftEntry ?? after?.draftEntry;

    if (objectType !== '17' || isDraft !== 'Y') {
      logger.info('ApprovalService.decide: skipping SaveDraftToDocument', {
        approvalRequestId,
        objectType,
        isDraft,
        reason: objectType !== '17' ? 'object_type_not_sales_order' : 'not_a_draft',
      });
      return null;
    }

    if (draftEntry === undefined || draftEntry === null || draftEntry === '') {
      logger.warn('ApprovalService.decide: approved draft missing DraftEntry; cannot post', {
        approvalRequestId,
        objectType,
        isDraft,
      });
      return {
        attempted: true,
        success: false,
        draftEntry: null,
        error:
          'Approval succeeded but DraftEntry is missing; draft still needs manual or automatic post retry.',
      };
    }

    try {
      const salesOrder = await this.postApprovedDraft(draftEntry);
      logger.info('ApprovalService.decide: SaveDraftToDocument succeeded', {
        approvalRequestId,
        draftEntry: String(draftEntry),
        docEntry: salesOrder?.DocEntry ?? salesOrder?.docEntry ?? null,
        docNum: salesOrder?.DocNum ?? salesOrder?.docNum ?? null,
      });
      return {
        attempted: true,
        success: true,
        draftEntry: String(draftEntry),
        result: salesOrder,
      };
    } catch (error) {
      const errorMessage = error?.message || String(error);
      logger.error(
        'ApprovalService.decide: SaveDraftToDocument failed after successful approval (approval not rolled back; draft needs retry)',
        {
          approvalRequestId,
          draftEntry: String(draftEntry),
          error: errorMessage,
          sapError: error?.meta?.cause ?? null,
          status: error?.meta?.status ?? null,
        }
      );
      return {
        attempted: true,
        success: false,
        draftEntry: String(draftEntry),
        error:
          `Approval succeeded in SAP, but posting the draft failed: ${errorMessage}. ` +
          'The draft still needs manual or automatic retry.',
      };
    }
  }

  async _executeWithSessionRecovery(operation, context) {
    await this.sessionManager.ensureLoggedIn();

    try {
      return await operation();
    } catch (error) {
      if (!this._isSessionExpirationError(error)) {
        throw error;
      }

      logger.warn('SAP session expired during approval processing; retrying once after re-login.', {
        ...context,
        message: this._getErrorMessage(error),
      });

      try {
        await this.sessionManager.logout();
        await this.sessionManager.login();
      } catch (reloginError) {
        throw new ApprovalSapError(`Failed to re-login for approval request ${context?.approvalRequestId ?? 'unknown'}.`, {
          approvalRequestId: context?.approvalRequestId,
          cause: this._getErrorMessage(reloginError),
        });
      }

      return operation();
    }
  }

  async _getApprovalRequest(approvalRequestId, selectClause = '') {
    try {
      const url = `/ApprovalRequests(${encodeURIComponent(approvalRequestId)})${selectClause ? `?${selectClause}` : ''}`;
      const response = await this.sessionManager.client.get(url);
      return response?.data ?? response;
    } catch (error) {
      throw new ApprovalSapError(`Failed to GET ApprovalRequest ${approvalRequestId}`, {
        approvalRequestId,
        cause: this._getErrorMessage(error),
      });
    }
  }

  async _patchApprovalRequest(approvalRequestId, payload) {
    return this.sessionManager.client.patch(`/ApprovalRequests(${encodeURIComponent(approvalRequestId)})`, payload);
  }

  _findApproverLine(approvalRequest, approverUserId) {
    const lines = approvalRequest.ApprovalRequestLines || [];
    return lines.find(
      (line) =>
        Number(line.UserID) === Number(approverUserId) &&
        Number(line.StageCode) === Number(approvalRequest.CurrentStage)
    );
  }

  _normalizeDecisionInput(input, approver, remarks) {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      return {
        approvalRequestId: input.approvalRequestId ?? input.approvalRequestID ?? input.id,
        approverUserId: input.approverUserId ?? input.userId ?? input.approver?.userId,
        approverUsername: input.approverUsername ?? input.approver?.username ?? input.approverCredentials?.username,
        approverPassword: input.approverPassword ?? input.approver?.password ?? input.approverCredentials?.password,
        remarks: input.remarks ?? remarks,
      };
    }

    return {
      approvalRequestId: input,
      approverUserId: approver?.userId ?? approver?.id,
      approverUsername: approver?.username,
      approverPassword: approver?.password,
      remarks,
    };
  }

  _normalizeApprovalRequestId(approvalRequestId) {
    return typeof approvalRequestId === 'string' ? approvalRequestId.trim() : String(approvalRequestId ?? '').trim();
  }

  _normalizeApproverUserId(approverUserId) {
    return approverUserId == null ? '' : String(approverUserId).trim();
  }

  _isSessionExpirationError(error) {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const status = error.response?.status;
    const message = this._getErrorMessage(error);
    return status === 401 || status === 403 || /session|login|unauthorized/i.test(message);
  }

  _getErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === 'string') {
      return error;
    }

    return 'Unknown SAP error';
  }
}
