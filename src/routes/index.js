import express from 'express';
import approvalRouter from './approval.js';
import footprintRouter from './footprint.js';
import healthRouter from './health.js';
import sapRouter from './sap.js';
import { getCompanyByHash, runInCompany } from '../services/company/companyContext.js';

const router = express.Router();

router.use('/health', healthRouter);

router.get('/queue/status', (req, res) => {
  res.json({
    status: 'ok',
    running: true,
    pollIntervalMs: 30000,
  });
});

// Company-scoped routes: /c/:companyHash/... The opaque hash resolves to exactly
// one company, and the entire request runs inside that company's context
// (HANA schema + Service Layer session), so a process_id is only ever looked up
// in its own schema — no cross-company access is possible.
function companyScope(req, res, next) {
  const company = getCompanyByHash(req.params.companyHash);
  if (!company) {
    return res.status(404).send('This link is not valid.');
  }
  runInCompany(company, () => next());
}

const companyRouter = express.Router({ mergeParams: true });
companyRouter.use('/', footprintRouter);
companyRouter.use('/', approvalRouter);
companyRouter.use('/sap', sapRouter);

router.use('/c/:companyHash', companyScope, companyRouter);

export default router;
