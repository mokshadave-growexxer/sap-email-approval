import logger from '../../config/logger.js';
import { config } from '../../config/index.js';
import { listCompanies, runInCompany, currentSL, currentCompany, currentCompanyHash } from '../company/companyContext.js';
import {
  PENDING_APPROVALS_PATH,
  isBeforeCreatedCutoff,
  getActionableApprovers,
  getAllPages,
} from '../sap/approvalRequestQueries.js';
import { getSalesOrderChangeStatus } from '../sap/draftStatusService.js';
import { createProcess, getRecordedLevelsByRequestAndUser } from '../approval/processStore.js';
import { resolveDraftEmailData, resolveSapUser, buildApprovalHistory } from '../email/approvalEmailService.js';
import { sendDigestEmail } from '../email/digestEmailService.js';
import { signDigestToken } from '../../utils/digestToken.js';
import { absoluteQueueUrl } from '../../utils/appUrls.js';

// ---------- Pure helpers (unit-tested) ----------

/**
 * Group live pending approval requests by the approver who may act on each RIGHT
 * NOW (the current actionable line). Mirrors the instant channel's "who to email"
 * rule exactly, so the digest never lists a SO the approver cannot act on.
 *
 * @param {Array<object>} pendingRequests - Raw ApprovalRequests from SAP.
 * @param {{ createdCutoff?: string|null }} [opts]
 * @returns {Map<string, Array<object>>} approverUserId -> actionable items.
 */
export function groupActionableByApprover(
  pendingRequests,
  { createdCutoff = null, stageFilter = null, levelsByKey = null } = {}
) {
  const byApprover = new Map();
  for (const req of pendingRequests || []) {
    const approvalRequestId = req.Code ?? req.Id ?? req.approvalRequestId;
    const currentStage = req.CurrentStage ?? req.currentStage;

    if (isBeforeCreatedCutoff(req.CreationDate, createdCutoff)) {
      continue;
    }

    const actionable = getActionableApprovers(req);
    if (actionable.length === 0) {
      continue;
    }

    const changeStatus = getSalesOrderChangeStatus(req);

    for (const line of actionable) {
      const approverUserId = line.UserID ?? line.UserId ?? line.ApproverUserID ?? line.ApproverUserId;
      if (!approvalRequestId || approverUserId == null) {
        continue;
      }

      // The "stage" is the sequential position of the current actionable approver
      // (1st pending approver = stage 1, 2nd = stage 2, …). This is what the
      // per-stage send times target. It works whether approvers sit on distinct
      // SAP StageCodes OR are sequential lines within a single StageCode — unlike
      // keying off the raw StageCode, which collapses same-code approvers together.
      //
      // Prefer the level recorded in @AP_APPROVAL (U_level) when one exists: it was
      // captured once, when the instant channel first queued this approver for this
      // request, so it can't drift from a live recomputation against SAP's current
      // ApprovalRequestLines. Only fall back to a fresh computation when no row has
      // been recorded yet (e.g. the request became actionable after the last poll).
      const recordedLevel = levelsByKey?.get(`${String(approvalRequestId)}:${String(approverUserId)}`);
      const stageNumber = recordedLevel ?? line.approverPosition ?? null;

      // When a stage filter is set (a per-stage scheduled send), only include SOs
      // currently awaiting that stage's approver.
      if (stageFilter != null && stageNumber !== stageFilter) {
        continue;
      }

      const key = String(approverUserId);
      if (!byApprover.has(key)) {
        byApprover.set(key, []);
      }
      byApprover.get(key).push({
        approvalRequestId,
        currentStage,
        approverUserId,
        approverPosition: stageNumber,
        draftEntry: req.DraftEntry ?? req.draftEntry ?? req.ObjectEntry ?? req.objectEntry,
        changeType: changeStatus.code,
        changeLabel: changeStatus.label,
        stageNumber,
        // Kept so the page can show the "approved by … / when" history without a
        // second fetch (the email does not use it).
        lines: req.ApprovalRequestLines || [],
      });
    }
  }
  return byApprover;
}

export function isDigestAllowedRecipient(email, allowlist = config.digest.allowlist) {
  return allowlist.includes(String(email || '').trim().toLowerCase());
}

/** Order value = sum(quantity x unit price) across the draft's lines. */
export function computeOrderValue(documentLines) {
  return (documentLines || []).reduce((sum, line) => {
    const quantity = Number(line?.Quantity);
    const price = Number(line?.Price ?? line?.UnitPrice);
    if (!Number.isFinite(quantity) || !Number.isFinite(price)) {
      return sum;
    }
    return sum + quantity * price;
  }, 0);
}

/** The document currency, taken from the first line that declares one. */
export function deriveCurrency(documentLines) {
  for (const line of documentLines || []) {
    if (line?.Currency) {
      return line.Currency;
    }
  }
  return '';
}

// ---------- Orchestration (runs inside a company context) ----------

/**
 * Build the per-SO view models for one approver's digest/queue and resolve full
 * draft detail for display.
 *
 * `ensureProcess` controls whether a process row is created/reused for each SO:
 *  - the bulk PAGE needs it (true) so its checkboxes carry a real process id;
 *  - the daily EMAIL does not (false), so the scheduled send performs no writes
 *    and can never pre-empt the instant channel (which treats any pending row as
 *    already handled). Rows are created lazily when the approver opens the page,
 *    by which time the instant email has long since gone out.
 *
 * @param {Array<object>} items - Grouped actionable items for one approver.
 * @param {{ userCode: string, approverEmail: string|null, ensureProcess?: boolean }} approver
 * @returns {Promise<Array<Readonly<object>>>}
 */
export async function buildApproverQueueItems(items, { userCode, approverEmail, ensureProcess = true }) {
  const out = [];
  for (const item of items) {
    const processId = ensureProcess
      ? (
          await createProcess({
            approvalRequestId: item.approvalRequestId,
            draftEntry: item.draftEntry,
            sapUserId: item.approverUserId,
            userCode,
            approverEmail,
            level: item.approverPosition,
          })
        ).id
      : null;

    const draft = await resolveDraftEmailData({
      approvalRequestId: item.approvalRequestId,
      draftEntry: item.draftEntry,
    });

    // The page shows the full order (including who has approved so far); the email
    // stays a summary, so history is only resolved for the page.
    const history = ensureProcess ? await buildApprovalHistory({ ApprovalRequestLines: item.lines || [] }) : [];

    out.push(
      Object.freeze({
        processId,
        approvalRequestId: item.approvalRequestId,
        docNum: draft.docNum,
        cardName: draft.cardName,
        docDate: draft.docDate,
        paymentTermName: draft.paymentTermName,
        incoterm: draft.incoterm,
        portOfLoading: draft.portOfLoading,
        portOfDischarge: draft.portOfDischarge,
        destinationCountry: draft.destinationCountry,
        labelType: draft.labelType,
        remark: draft.remark,
        documentLines: draft.documentLines,
        itemCount: draft.documentLines.length,
        orderValue: computeOrderValue(draft.documentLines),
        currency: deriveCurrency(draft.documentLines),
        changeType: item.changeType,
        changeLabel: item.changeLabel,
        history,
      })
    );
  }
  return out;
}

/**
 * The live queue for ONE approver: re-derives their currently-actionable SOs from
 * SAP (the source of truth) and builds the per-SO view models. Used by the bulk
 * page on load, so it always reflects what the approver may act on right now — a
 * SO decided or edited since the digest was sent simply won't appear.
 */
export async function buildApproverQueueForUser(sapUserId, { userCode, approverEmail }) {
  const session = currentSL();
  await session.ensureLoggedIn();
  const pending = await getAllPages(session, PENDING_APPROVALS_PATH);
  const byApprover = groupActionableByApprover(pending, { createdCutoff: config.approvalMinCreatedDate ?? null });
  const items = byApprover.get(String(sapUserId)) || [];
  return buildApproverQueueItems(items, { userCode, approverEmail });
}

async function sendDigestForApprover({ sapUserId, items }) {
  const sapUser = await resolveSapUser(sapUserId);
  const userCode = sapUser.userCode;
  const email = sapUser.email;

  if (!userCode) {
    logger.warn('digestService: could not resolve SAP UserCode for approver — skipping', { sapUserId });
    return { sent: false, reason: 'usercode_missing' };
  }
  if (!email) {
    logger.warn('digestService: approver has no email (OUSR eMail) — skipping', { sapUserId, userCode });
    return { sent: false, reason: 'approver_email_missing' };
  }
  if (!isDigestAllowedRecipient(email)) {
    logger.info('digestService: recipient not on the digest allowlist — skipping', { sapUserId, to: email });
    return { sent: false, reason: 'not_in_digest_allowlist' };
  }

  // The email lists SOs and links to the page; it needs no process rows (those
  // are created lazily when the approver opens the page).
  const queue = await buildApproverQueueItems(items, { userCode, approverEmail: email, ensureProcess: false });
  if (queue.length === 0) {
    return { sent: false, reason: 'no_items' };
  }

  const token = signDigestToken({ sapUserId });
  const actionUrl = absoluteQueueUrl(currentCompanyHash(), token);

  await sendDigestEmail({
    to: email,
    approverName: sapUser.name || userCode,
    items: queue,
    actionUrl,
  });

  return { sent: true, count: queue.length };
}

/**
 * Run the digest for the currently-active company (must be inside runInCompany).
 * `stageFilter` (1, 2, …) restricts the send to approvers currently at that stage;
 * null sends every actionable approver (used by the manual/one-off trigger).
 */
export async function runDigestForCompany({ stageFilter = null } = {}) {
  const company = currentCompany();
  const session = currentSL();
  await session.ensureLoggedIn();

  const pending = await getAllPages(session, PENDING_APPROVALS_PATH);
  const levelsByKey = await getRecordedLevelsByRequestAndUser();
  const byApprover = groupActionableByApprover(pending, {
    createdCutoff: config.approvalMinCreatedDate ?? null,
    stageFilter,
    levelsByKey,
  });

  let sent = 0;
  let skipped = 0;
  for (const [sapUserId, items] of byApprover) {
    try {
      const result = await sendDigestForApprover({ sapUserId, items });
      if (result?.sent) {
        sent += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      logger.error('digestService: failed to send digest for approver', {
        company: company.key,
        sapUserId,
        error: error?.message || String(error),
      });
    }
  }

  logger.info('digestService: company digest run complete', {
    company: company.key,
    stageFilter,
    approvers: byApprover.size,
    sent,
    skipped,
  });
  return { approvers: byApprover.size, sent, skipped };
}

/**
 * The scheduler entry point: run the digest for every configured company.
 * `stageFilter` restricts to one stage (per-stage scheduled sends); omit it for a
 * manual all-stages run.
 */
export async function runDigestAllCompanies({ stageFilter = null } = {}) {
  if (!config.digest.enabled) {
    logger.info('digestService: digest disabled (DIGEST_ENABLED=false); nothing to send');
    return;
  }
  for (const company of listCompanies()) {
    try {
      await runInCompany(company, () => runDigestForCompany({ stageFilter }));
    } catch (error) {
      logger.error('digestService: company digest run failed', {
        company: company.key,
        stageFilter,
        error: error?.message || String(error),
      });
    }
  }
}
