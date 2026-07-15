import express from 'express';
import { healthCheck } from '../controllers/healthController.js';
import { healthSapCheck } from '../controllers/healthSapController.js';

const router = express.Router();

router.get('/', healthCheck);
router.get('/sap', healthSapCheck);

export default router;
