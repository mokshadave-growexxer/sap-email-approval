import express from 'express';
import logger from '../config/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { verifyDigestToken } from '../utils/digestToken.js';
import { resolveSapUser } from '../services/email/approvalEmailService.js';
import { buildApproverQueueForUser } from '../services/digest/digestService.js';
import { getApproverCredential, upsertApproverCredential } from '../services/security/userCredentialStore.js';
import { registerDigestGate, consumeDigestGate } from '../services/security/digestFootprintGate.js';
import {
  GEO_METHOD,
  captureServerSideFootprint,
  refineOperatingSystem,
} from '../services/security/footprintService.js';
import { runBulkDecision, BULK_RESULT } from '../services/digest/bulkDecisionService.js';
import { currentCompanyHash } from '../services/company/companyContext.js';
import {
  companyQueuePath,
  companyQueueFootprintRegisterPath,
  companyQueueClientPath,
} from '../utils/appUrls.js';
import { QUEUE_CLIENT_JS } from './queueClientScript.js';

const router = express.Router();

const ACTIONS = Object.freeze({ APPROVE: 'approve', REJECT: 'reject' });
const VALID_GEO_METHODS = new Set(Object.values(GEO_METHOD));

const RESULT_LABEL = Object.freeze({
  [BULK_RESULT.APPROVED]: 'Approved',
  [BULK_RESULT.REJECTED]: 'Rejected',
  [BULK_RESULT.SUPERSEDED]: 'No longer active (changed or decided elsewhere)',
  [BULK_RESULT.LOCKED]: 'Being edited — try again shortly',
  [BULK_RESULT.FAILED]: 'Could not be processed',
  [BULK_RESULT.ALREADY_DECIDED]: 'Already decided',
  [BULK_RESULT.NOT_ACTIONABLE]: 'No longer awaiting your decision',
});

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

function formatQty(value) {
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : escapeHtml(value ?? '');
}

function formatDate(docDate) {
  const iso = String(docDate ?? '').slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

// Total freight for a line = quantity x freight-per-kg (U_Freight_pkg). Empty when
// either value is missing.
function lineFreightTotal(line) {
  const quantity = Number(line?.Quantity);
  const perKg = Number(line?.U_Freight_pkg);
  if (!Number.isFinite(quantity) || !Number.isFinite(perKg)) {
    return '';
  }
  return formatMoney(quantity * perKg);
}

const PAGE_STYLE = `
  *{box-sizing:border-box;}
  body{margin:0; background:#eef1f6; color:#161b26; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; font-size:14px; line-height:1.45;}
  .masthead{background:#101d33; color:#f3f5fa; padding:20px 16px;}
  .masthead-inner{max-width:1080px; margin:0 auto; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;}
  .masthead h1{font-size:19px; margin:0 0 3px; font-weight:700;}
  .masthead p{margin:0; color:#aab4c9; font-size:12.5px;}
  .pending-chip{background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.14); padding:8px 14px; border-radius:8px; text-align:center; white-space:nowrap;}
  .pending-chip .count{font-size:18px; font-weight:700; display:block;}
  .pending-chip .lbl{font-size:10.5px; color:#aab4c9; text-transform:uppercase; letter-spacing:0.06em;}
  .page{max-width:1080px; margin:0 auto; padding:16px 16px 64px;}
  .status{display:flex; align-items:center; gap:10px; margin:14px 0; padding:12px 14px; border-radius:8px; background:#eef1f7; color:#334a72; font-size:13.5px;}
  .status.ok{background:#e7f6ec; color:#0c6432;}
  .status.err{background:#fbeae9; color:#8f1e18;}
  .status.info{background:#eef3fb; color:#1a2b4c;}
  .spinner{width:15px; height:15px; border:2px solid #cbd5e1; border-top-color:#1a2b4c; border-radius:50%; animation:spin .8s linear infinite; flex:0 0 auto;}
  @keyframes spin{to{transform:rotate(360deg);}}
  .toolbar{position:sticky; top:0; z-index:5; background:#fff; border:1px solid #e0e4ec; border-radius:10px; box-shadow:0 1px 2px rgba(16,29,51,0.06); margin:12px 0 14px; padding:12px 14px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;}
  .toolbar label.selall{display:flex; align-items:center; gap:8px; font-size:13px; color:#66707f;}
  input[type=search], input[type=text], input[type=password]{font:inherit; font-size:13px; color:#161b26; background:#f6f7fb; border:1px solid #c7cede; border-radius:7px; padding:8px 11px;}
  input[type=search]{min-width:180px;}
  .remark-box{flex:1 1 220px; min-width:180px;}
  .spacer{flex:1 1 auto;}
  .selcount{font-size:13px; color:#66707f; white-space:nowrap;}
  .selcount b{color:#161b26;}
  .btn{font:inherit; font-weight:600; font-size:13.5px; cursor:pointer; border-radius:7px; padding:9px 16px; border:1px solid transparent; display:inline-flex; align-items:center; gap:6px;}
  .btn:disabled{opacity:0.4; cursor:not-allowed;}
  .btn-approve{background:#0f7a3d; color:#fff;}
  .btn-reject{background:#b3261e; color:#fff;}
  .btn-ghost{background:#374151; color:#fff; display:none;}
  input[type=checkbox]{width:17px; height:17px; cursor:pointer; margin:0;}
  .queue{display:flex; flex-direction:column; gap:10px;}
  .so-row{background:#fff; border:1px solid #e0e4ec; border-radius:10px; box-shadow:0 1px 2px rgba(16,29,51,0.06); overflow:hidden;}
  .so-row-main{display:grid; grid-template-columns:26px 24px 1.1fr 1.3fr 1.3fr 84px 130px 96px; align-items:center; gap:12px; padding:13px 15px;}
  .chevron{background:none; border:none; padding:4px; cursor:pointer; color:#66707f; display:flex; align-items:center; border-radius:6px;}
  .so-row.expanded .chevron svg{transform:rotate(90deg);}
  .chevron svg{transition:transform .15s ease;}
  .so-number{font-weight:700; font-size:13.5px;}
  .badge{display:inline-block; margin-top:4px; font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; padding:2px 7px; border-radius:20px;}
  .badge.updated{background:#fef3e2; color:#b45309;}
  .badge.new{background:#eef1f7; color:#334a72;}
  .cust-name{font-weight:600; font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
  .cust-doctype{font-size:11.5px; color:#66707f; margin-top:2px;}
  .so-terms{font-size:12px; color:#66707f; line-height:1.5; min-width:0;}
  .so-terms b{color:#161b26;}
  .so-terms div{white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
  .so-items-count{font-size:12.5px; color:#66707f;}
  .so-total{font-weight:700; font-size:13.5px; text-align:right;}
  .so-total small{display:block; font-weight:500; color:#8993a3; font-size:10.5px;}
  .so-date{font-size:12px; color:#66707f; text-align:right; white-space:nowrap;}
  .so-items-panel{border-top:1px solid #e0e4ec; background:#f6f7fb; padding:14px 16px;}
  .items-wrap{overflow-x:auto; border:1px solid #e0e4ec; border-radius:8px;}
  table.items{border-collapse:collapse; width:100%; min-width:760px; background:#fff;}
  table.items th{text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:0.03em; color:#66707f; font-weight:600; padding:8px 12px; border-bottom:1px solid #e0e4ec; white-space:nowrap;}
  table.items td{padding:9px 12px; font-size:12.5px; border-bottom:1px solid #e0e4ec; white-space:nowrap;}
  table.items td.num, table.items th.num{text-align:right;}
  table.items tr:last-child td{border-bottom:none;}
  .rmk{margin:10px 2px 0; font-size:12px; color:#66707f;}
  .detail-meta{display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px 18px; margin-bottom:14px;}
  .detail-meta .dm{display:flex; justify-content:space-between; gap:12px; padding:7px 11px; background:#fff; border:1px solid #e0e4ec; border-radius:6px; font-size:12.5px;}
  .detail-meta .dm span{color:#66707f;}
  .detail-meta .dm b{color:#161b26; text-align:right; word-break:break-word;}
  .history{margin-bottom:14px; background:#e7f6ec; border-radius:6px; padding:4px 0;}
  .history .hist-line{padding:5px 12px; font-size:12.5px; color:#0c6432;}
  .empty{padding:44px 20px; text-align:center; color:#66707f; background:#fff; border:1px dashed #c7cede; border-radius:10px;}
  .pw-box{background:#eef3fb; border:1px solid #c7cede; border-radius:10px; padding:16px; margin:12px 0;}
  .pw-box label{display:block; font-weight:700; font-size:13px; margin-bottom:8px;}
  .pw-box input{width:100%; max-width:320px;}
  .pw-box p{margin:8px 0 0; font-size:12px; color:#66707f;}
  .card{background:#fff; border:1px solid #e0e4ec; border-radius:10px; padding:24px; box-shadow:0 1px 2px rgba(16,29,51,0.06);}
  .card h2{margin:0 0 12px; font-size:18px;}
  .summary-line{display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #eef1f6; font-size:14px;}
  a.back{display:inline-block; margin-top:16px; color:#2563eb; font-weight:600; text-decoration:none;}
  a.back:hover{text-decoration:underline;}
  @media (max-width:820px){
    .so-row-main{grid-template-columns:24px 22px 1fr auto; grid-template-areas:"chk chev id total" "chk chev cust cust" "chk chev terms terms" "chk chev count date"; row-gap:6px;}
    .so-row-main .chk-cell{grid-area:chk;} .so-row-main .chevron{grid-area:chev;} .so-id{grid-area:id;}
    .so-total{grid-area:total;} .so-customer{grid-area:cust;} .so-terms{grid-area:terms;}
    .so-items-count{grid-area:count;} .so-date{grid-area:date;}
  }
  @media (prefers-color-scheme:dark){
    body{background:#0b111d; color:#e9edf5;}
    .toolbar,.so-row,.card{background:#121a2b; border-color:#243149;}
    input[type=search],input[type=text],input[type=password]{background:#0e1524; border-color:#33415c; color:#e9edf5;}
    .so-items-panel{background:#0e1524;} table.items{background:#121a2b;} table.items th,table.items td{border-color:#243149;}
    .detail-meta .dm{background:#121a2b; border-color:#243149;} .detail-meta .dm b{color:#e9edf5;} .history{background:#0f2a1c;} .history .hist-line{color:#6fe0a1;}
    .so-cust .cust-doctype,.so-terms,.so-items-count,.so-date,.selcount{color:#9aa6bc;}
    .empty{background:#121a2b;} .pw-box{background:#182338; border-color:#33415c;}
    a.back{color:#7ea2e8;}
  }
  @media (prefers-reduced-motion:reduce){*{transition:none!important;}}
`;

function lineTable(item) {
  const head =
    '<tr><th>Sr.</th><th>Product Name</th><th>Brand Name</th><th>Packing Code</th><th>Packing Name</th>' +
    '<th class="num">Quantity</th><th class="num">Ex-Work</th><th class="num">FOB</th><th class="num">Freight</th><th class="num">Total Freight</th><th class="num">Price</th><th>Currency</th></tr>';
  const rows = (item.documentLines || [])
    .map(
      (line, i) =>
        `<tr><td>${i + 1}</td>` +
        `<td>${escapeHtml(line?.ItemDescription ?? '')}</td>` +
        `<td>${escapeHtml(line?.FreeText ?? '')}</td>` +
        `<td>${escapeHtml(line?.U_Pcode ?? '')}</td>` +
        `<td>${escapeHtml(line?.PackingItemName ?? '')}</td>` +
        `<td class="num">${escapeHtml(formatQty(line?.Quantity))}</td>` +
        `<td class="num">${escapeHtml(formatMoney(line?.U_Ex_work_pkg))}</td>` +
        `<td class="num">${escapeHtml(formatMoney(line?.U_FOB_pkg))}</td>` +
        `<td class="num">${escapeHtml(formatMoney(line?.U_Freight_pkg))}</td>` +
        `<td class="num">${escapeHtml(lineFreightTotal(line))}</td>` +
        `<td class="num">${escapeHtml(formatMoney(line?.Price ?? line?.UnitPrice))}</td>` +
        `<td>${escapeHtml(line?.Currency ?? '')}</td></tr>`
    )
    .join('');
  return `<div class="items-wrap"><table class="items">${head}${
    rows || '<tr><td colspan="12">No line items.</td></tr>'
  }</table></div>`;
}

// The full order shown inside the expand/collapse dropdown: every header field a
// single-SO approval shows, the approval history so far, then the line items.
function orderDetail(item) {
  // Order Value and Document Date are omitted here — they already appear in the
  // row header above the dropdown.
  const metaRows = [
    ['Customer', item.cardName],
    ['Payment Term', item.paymentTermName],
    ['Incoterms', item.incoterm],
    ['Port of Loading', item.portOfLoading],
    ['Port of Discharge', item.portOfDischarge],
    ['Destination Country', item.destinationCountry],
    ['Label Type', item.labelType],
    ['Remark', item.remark],
  ]
    .map(([label, value]) => `<div class="dm"><span>${escapeHtml(label)}</span><b>${escapeHtml(value || '—')}</b></div>`)
    .join('');
  const metaBlock = `<div class="detail-meta">${metaRows}</div>`;

  const historyBlock =
    item.history && item.history.length
      ? `<div class="history">${item.history
          .map(
            (h) => `<div class="hist-line">&#10003; Approved by <b>${escapeHtml(h.name)}</b> &mdash; ${escapeHtml(h.decidedAt)}</div>`
          )
          .join('')}</div>`
      : '';

  return metaBlock + historyBlock + lineTable(item);
}

function queueRow(item, selectedIds) {
  const badge =
    item.changeType === 'UPDATED'
      ? '<span class="badge updated">Updated</span>'
      : '<span class="badge new">New</span>';
  const checked = selectedIds.has(String(item.processId)) ? 'checked' : '';
  const search = `${item.docNum} ${item.cardName}`;
  const valueCell = item.orderValue ? `${escapeHtml(item.currency || '')} ${formatMoney(item.orderValue)}`.trim() : '';
  return `
    <div class="so-row expanded" data-search="${escapeHtml(search)}">
      <div class="so-row-main">
        <span class="chk-cell"><input type="checkbox" class="row-check" name="selected" value="${escapeHtml(item.processId)}" aria-label="Select SO ${escapeHtml(item.docNum)}" ${checked} /></span>
        <button class="chevron" type="button" aria-label="Toggle line items for SO ${escapeHtml(item.docNum)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
        </button>
        <div class="so-id"><span class="so-number">${escapeHtml(item.docNum)}</span><br/>${badge}</div>
        <div class="so-customer"><div class="cust-name">${escapeHtml(item.cardName)}</div><div class="cust-doctype">Sales Order</div></div>
        <div class="so-terms"><div><b>Terms:</b> ${escapeHtml(item.paymentTermName || '—')}</div><div><b>Incoterms:</b> ${escapeHtml(item.incoterm || '—')}</div></div>
        <div class="so-items-count">${item.itemCount} item${item.itemCount === 1 ? '' : 's'}</div>
        <div class="so-total">${escapeHtml(valueCell)}<small>order value</small></div>
        <div class="so-date">${escapeHtml(formatDate(item.docDate))}</div>
      </div>
      <div class="so-items-panel">${orderDetail(item)}</div>
    </div>`;
}

/**
 * Render the bulk digest approval page. Pure — takes fully-resolved view models.
 */
export function renderQueuePage({
  token,
  companyHash,
  approverName,
  items = [],
  message = '',
  messageKind = 'info',
  needsPassword = false,
  selectedIds = new Set(),
  remarks = '',
}) {
  const action = escapeHtml(companyQueuePath(companyHash, token));
  const registerUrl = escapeHtml(companyQueueFootprintRegisterPath(companyHash, token));
  const clientUrl = escapeHtml(companyQueueClientPath(companyHash));
  const selected = new Set([...selectedIds].map((id) => String(id)));

  const rowsHtml = items.length
    ? `<div class="queue">${items.map((item) => queueRow(item, selected)).join('')}</div>`
    : '<div class="empty">You have no pending sales order approvals right now.</div>';

  const messageHtml = message
    ? `<div class="status ${messageKind === 'error' ? 'err' : messageKind === 'ok' ? 'ok' : 'info'}">${escapeHtml(message)}</div>`
    : '';

  const passwordHtml = needsPassword
    ? `<div class="pw-box">
         <label for="sap_password">Enter your SAP password</label>
         <input type="password" id="sap_password" name="sap_password" autocomplete="off" autocapitalize="off" spellcheck="false" required placeholder="Your SAP password" />
         <p>Enter your SAP password once to authorize these decisions. It is stored securely (encrypted) and used only to submit your approvals to SAP — you won’t be asked again unless your SAP password changes.</p>
       </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pending Sales Order Approvals</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="masthead">
    <div class="masthead-inner">
      <div>
        <h1>Pending Sales Order Approvals</h1>
        <p>${escapeHtml(approverName || '')} &middot; review and decide in bulk</p>
      </div>
      <div class="pending-chip"><span class="count">${items.length}</span><span class="lbl">Awaiting decision</span></div>
    </div>
  </div>
  <div class="page">
    ${messageHtml}
    <form method="post" action="${action}" data-queue data-token="${escapeHtml(token)}" data-register-url="${registerUrl}" autocomplete="off">
      <input type="hidden" id="session_id" name="session_id" value="" />
      ${passwordHtml}
      <div class="toolbar">
        <label class="selall"><input type="checkbox" id="selectAll" /> Select all</label>
        <input type="search" id="searchBox" placeholder="Search customer or SO #" aria-label="Search" />
        <input type="text" class="remark-box" id="remarks" name="remarks" placeholder="Remark (optional, applied to all)" value="${escapeHtml(remarks)}" />
        <span class="spacer"></span>
        <span class="selcount"><b id="selectedCount">0</b> selected</span>
        <button class="btn btn-reject" id="rejectBtn" type="submit" name="decision" value="reject" disabled>Reject</button>
        <button class="btn btn-approve" id="approveBtn" type="submit" name="decision" value="approve" disabled>Approve</button>
      </div>
      <div id="geo-status" class="status"><span class="spinner"></span><span id="geo-text">Verifying your device and location…</span><button id="geo-retry" class="btn btn-ghost" type="button">Retry</button></div>
      ${rowsHtml}
    </form>
  </div>
  <script src="${clientUrl}"></script>
</body>
</html>`;
}

function renderMessagePage({ title, message }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="masthead"><div class="masthead-inner"><div><h1>${escapeHtml(title)}</h1></div></div></div>
  <div class="page"><div class="card"><div class="status err">${escapeHtml(message)}</div></div></div>
</body>
</html>`;
}

function renderResultPage({ companyHash, token, counts, details }) {
  const order = [
    BULK_RESULT.APPROVED,
    BULK_RESULT.REJECTED,
    BULK_RESULT.SUPERSEDED,
    BULK_RESULT.LOCKED,
    BULK_RESULT.ALREADY_DECIDED,
    BULK_RESULT.NOT_ACTIONABLE,
    BULK_RESULT.FAILED,
  ];
  const lines = order
    .filter((code) => counts[code])
    .map(
      (code) => `<div class="summary-line"><span>${escapeHtml(RESULT_LABEL[code])}</span><b>${counts[code]}</b></div>`
    )
    .join('');
  const detailHtml = details
    ? `<p class="rmk">${escapeHtml(details)}</p>`
    : '';
  const backUrl = escapeHtml(companyQueuePath(companyHash, token));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Decisions Submitted</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="masthead"><div class="masthead-inner"><div><h1>Decisions Submitted</h1></div></div></div>
  <div class="page"><div class="card">
    <h2>Summary</h2>
    ${lines || '<div class="summary-line"><span>No decisions were made.</span><b>0</b></div>'}
    ${detailHtml}
    <a class="back" href="${backUrl}">Return to your pending approvals →</a>
  </div></div>
</body>
</html>`;
}

// ---------- token / approver resolution ----------

async function resolveApprover(token) {
  const verified = verifyDigestToken(token);
  if (!verified.valid) {
    return { ok: false, expired: verified.expired };
  }
  const sapUser = await resolveSapUser(verified.sapUserId);
  if (!sapUser.userCode) {
    return { ok: false, expired: false };
  }
  return {
    ok: true,
    sapUserId: verified.sapUserId,
    userCode: sapUser.userCode,
    email: sapUser.email,
    name: sapUser.name || sapUser.userCode,
  };
}

function normalizeSelected(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).filter(Boolean);
  }
  if (value == null || value === '') {
    return [];
  }
  return [String(value)];
}

// ---------- routes ----------

// Static browser client for the bulk page (served from app origin -> CSP 'self').
router.get('/queue/client.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(QUEUE_CLIENT_JS);
});

// Footprint gate register for the bulk page (token-scoped -> one gate per approver).
router.post(
  '/queue/:token/footprint/register',
  asyncHandler(async (req, res) => {
    const verified = verifyDigestToken(req.params.token);
    if (!verified.valid) {
      return res.status(400).json({ session_id: null, reason: 'invalid link' });
    }
    const { lat, lon, accuracy, timezone } = req.body || {};
    const geoMethod = VALID_GEO_METHODS.has(req.body?.geo_method) ? req.body.geo_method : GEO_METHOD.UNAVAILABLE;
    const serverFootprint = await captureServerSideFootprint(req);
    const operatingSystem = refineOperatingSystem(serverFootprint.operatingSystem, req.body?.ua_platform_version);

    let result;
    try {
      result = await registerDigestGate({
        sapUserId: verified.sapUserId,
        geoMethod: lat != null && lon != null ? GEO_METHOD.GRANTED : geoMethod,
        lat,
        lon,
        accuracy,
        timezone,
        serverFootprint: { ...serverFootprint, operatingSystem },
      });
    } catch (error) {
      logger.warn('queue/footprint/register: could not register gate', { error: error?.message || String(error) });
      return res.status(400).json({ session_id: null, reason: 'invalid link' });
    }

    if (result.sessionId) {
      return res.status(201).json({ session_id: result.sessionId });
    }
    return res.status(201).json({ session_id: null, reason: result.geoMethod });
  })
);

// The bulk page.
router.get(
  '/queue/:token',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const approver = await resolveApprover(req.params.token);
    if (!approver.ok) {
      return res.status(approver.expired ? 410 : 404).send(
        renderMessagePage({
          title: approver.expired ? 'Link Expired' : 'Invalid Link',
          message: approver.expired
            ? 'This approvals link has expired. Please use the most recent digest email, or contact your SAP administrator.'
            : 'This approvals link is invalid or no longer exists.',
        })
      );
    }

    const items = await buildApproverQueueForUser(approver.sapUserId, {
      userCode: approver.userCode,
      approverEmail: approver.email,
    });

    return res.status(200).send(
      renderQueuePage({
        token: req.params.token,
        companyHash: currentCompanyHash(),
        approverName: approver.name,
        items,
      })
    );
  })
);

// The bulk decision.
router.post(
  '/queue/:token',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = req.params.token;
    const companyHash = currentCompanyHash();
    const approver = await resolveApprover(token);
    if (!approver.ok) {
      return res.status(approver.expired ? 410 : 404).send(
        renderMessagePage({
          title: approver.expired ? 'Link Expired' : 'Invalid Link',
          message: approver.expired
            ? 'This approvals link has expired. Please use the most recent digest email.'
            : 'This approvals link is invalid or no longer exists.',
        })
      );
    }

    const decision = req.body?.decision;
    const action = decision === ACTIONS.APPROVE || decision === ACTIONS.REJECT ? decision : null;
    const selected = normalizeSelected(req.body?.selected);
    const remarks = req.body?.remarks || '';
    const sessionId = req.body?.session_id;
    const typedPassword = req.body?.sap_password || '';
    const enrollOnSuccess = Boolean(typedPassword);

    const reRenderQueue = async (overrides) => {
      const items = await buildApproverQueueForUser(approver.sapUserId, {
        userCode: approver.userCode,
        approverEmail: approver.email,
      });
      return renderQueuePage({
        token,
        companyHash,
        approverName: approver.name,
        items,
        selectedIds: new Set(selected),
        remarks,
        ...overrides,
      });
    };

    if (!action) {
      return res.status(400).send(await reRenderQueue({ message: 'Please choose Approve or Reject.', messageKind: 'error' }));
    }
    if (selected.length === 0) {
      return res.status(400).send(
        await reRenderQueue({ message: 'Select at least one sales order first.', messageKind: 'error' })
      );
    }

    // Resolve the credential before consuming the footprint gate, so a not-yet-
    // enrolled approver is prompted without wasting their capture.
    let effectivePassword = typedPassword;
    if (!typedPassword) {
      const credential = await getApproverCredential(approver.userCode);
      if (!credential.found) {
        return res.status(200).send(
          await reRenderQueue({
            needsPassword: true,
            messageKind: 'info',
            message: 'First time here — enter your SAP password once to authorize these decisions.',
          })
        );
      }
      effectivePassword = credential.password;
    }

    // Footprint gate — the single location/device boundary for the whole batch.
    const gate = await consumeDigestGate({ sessionId, sapUserId: approver.sapUserId });
    if (!gate.ok) {
      logger.warn('queue route: footprint gate rejected bulk decision', { reason: gate.reason });
      return res.status(403).send(
        await reRenderQueue({
          message: 'Location verification is required. Please allow location access and try again.',
          messageKind: 'error',
        })
      );
    }

    const { counts, anySuccess, credentialRejected } = await runBulkDecision({
      sapUserId: approver.sapUserId,
      action,
      selected,
      effectivePassword,
      remarks,
      gateSession: gate.session,
    });

    // A rejected password with nothing yet decided: re-prompt for the whole batch.
    if (credentialRejected && !anySuccess) {
      logger.info('queue route: SAP rejected credentials for bulk decision — re-prompting', { wasStored: !enrollOnSuccess });
      return res.status(200).send(
        await reRenderQueue({
          needsPassword: true,
          messageKind: enrollOnSuccess ? 'error' : 'info',
          message: enrollOnSuccess
            ? 'That SAP password was not accepted. Please check it and try again.'
            : 'Your SAP password may have changed. Please enter your current SAP password once to continue.',
        })
      );
    }

    if (enrollOnSuccess && anySuccess) {
      try {
        await upsertApproverCredential(approver.userCode, typedPassword);
      } catch (storeError) {
        logger.error('queue route: bulk approval succeeded but storing the credential failed', {
          userCode: approver.userCode,
          error: storeError?.message || String(storeError),
        });
      }
    }

    const locked = counts[BULK_RESULT.LOCKED];
    const details =
      locked > 0
        ? 'Some documents are being edited by another user. Reopen your pending approvals shortly to retry those.'
        : '';

    return res.status(200).send(renderResultPage({ companyHash, token, counts, details }));
  })
);

export default router;
