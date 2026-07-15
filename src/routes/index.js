import express from 'express';
import approvalRouter from './approval.js';
import healthRouter from './health.js';
import sapRouter from './sap.js';
import { queueWorker } from '../services/queue/queueWorker.js';

const router = express.Router();

router.use('/health', healthRouter);
router.use('/', approvalRouter);
router.use('/sap', sapRouter);

router.get('/queue/status', (req, res) => {
  res.json({
    status: 'ok',
    running: true,
    pollIntervalMs: 30000,
  });
});

export default router;
