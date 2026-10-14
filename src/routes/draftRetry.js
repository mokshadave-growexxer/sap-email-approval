// The one way a parked draft becomes postable again.
//
// The guard never un-parks a draft on its own — that is what keeps a broken
// draft from burning a SAP DocEntry on every poll. So the alert email carries a
// signed link here. This route only clears the park; it does not post anything
// itself. The next queue cycle picks the draft up (verifying against SAP first),
// which keeps all posting on the one audited path.

import express from 'express';
import logger from '../config/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { currentCompany } from '../services/company/companyContext.js';
import { verifyDraftRetryToken } from '../utils/draftRetryToken.js';
import { clearPark, getRecord, DRAFT_POST_STATE } from '../services/sap/draftPostState.js';

const router = express.Router({ mergeParams: true });

function page(title, body, tone = '#1f6feb') {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;padding:32px 16px;background:#f5f7fa;font-family:Segoe UI,Arial,sans-serif;color:#1f2933">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:8px;padding:28px;border-top:4px solid ${tone}">
<h1 style="margin:0 0 12px;font-size:20px">${title}</h1>
<div style="font-size:14px;line-height:1.6;color:#3e4c59">${body}</div>
</div></body></html>`;
}

router.get(
  '/draft-retry/:token',
  asyncHandler(async (req, res) => {
    const verdict = verifyDraftRetryToken(req.params.token);

    if (!verdict.valid) {
      return res
        .status(400)
        .send(
          page(
            verdict.expired ? 'This retry link has expired' : 'This link is not valid',
            verdict.expired
              ? 'Retry links stay valid for 30 days. Post the draft directly in SAP, or ask for a fresh alert.'
              : 'The link could not be verified. Please use the button in the original alert email.',
            '#a61b1b'
          )
        );
    }

    const company = currentCompany();
    const { approvalRequestId, draftEntry } = verdict;
    const record = await getRecord(company.key, approvalRequestId, draftEntry);

    if (record?.state === DRAFT_POST_STATE.POSTED) {
      return res.send(
        page(
          'Already posted',
          `Draft <strong>${draftEntry}</strong> has already become Sales Order <strong>${record.docEntry ?? '—'}</strong>. Nothing to do.`,
          '#2f855a'
        )
      );
    }

    const cleared = await clearPark(company.key, approvalRequestId, draftEntry);

    if (!cleared) {
      return res.send(
        page(
          'Nothing is parked',
          `Draft <strong>${draftEntry}</strong> is not currently parked, so it is already queued or in progress. No action was taken.`,
          '#b7791f'
        )
      );
    }

    logger.info('draftRetry: park cleared by retry link', {
      company: company.key,
      approvalRequestId,
      draftEntry,
      ip: req.ip,
    });

    return res.send(
      page(
        'Queued for retry',
        `Draft <strong>${draftEntry}</strong> will be posted on the next cycle (within about a minute).<br><br>
         If it fails again you will get another alert with the new SAP error.`,
        '#2f855a'
      )
    );
  })
);

export default router;
