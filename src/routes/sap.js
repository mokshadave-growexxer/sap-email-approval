import express from 'express';
import { currentSL } from '../services/company/companyContext.js';
import { ApprovalService } from '../services/sap/approvalService.js';
import { apiResponse } from '../utils/apiResponse.js';

const router = express.Router();
const approvalService = new ApprovalService();

async function requireSapSession() {
  return currentSL().ensureLoggedIn();
}

router.get('/service-info', async (req, res, next) => {
  try {
    const session = await requireSapSession();

    res.status(200).json(
      apiResponse.success({
        message: 'SAP Service Layer connection is healthy',
        data: {
          connected: true,
          version: session.version,
          company: session.company,
          sessionAlive: true,
        },
      })
    );
  } catch (error) {
    next(error);
  }
});

router.get('/approval-requests', async (req, res, next) => {
  try {
    await requireSapSession();
    const response = await currentSL().client.get(
      "/ApprovalRequests?$filter=Status%20eq%20'arsPending'%20and%20ObjectType%20eq%20'17'%20and%20IsDraft%20eq%20'Y'&$select=Code,Status,CurrentStage,ObjectType,IsDraft,ObjectEntry,DraftEntry,ApprovalRequestLines"
    );

    res.status(200).json(
      apiResponse.success({
        message: 'Pending approval requests retrieved successfully',
        data: response?.data?.value ?? response?.data ?? response ?? [],
      })
    );
  } catch (error) {
    next(error);
  }
});

router.post('/test-approve/:code', async (req, res, next) => {
  try {
    const approvalRequestId = req.params.code;
    const { username, password, userId, remarks = '' } = req.body ?? {};

    const result = await approvalService.approveRequest(
      {
        approvalRequestId,
        approverUserId: userId,
        approverUsername: username,
        approverPassword: password,
      },
      undefined,
      remarks
    );

    const draftPostFailed = result?.draftPost?.attempted && result.draftPost.success === false;
    res.status(200).json(
      apiResponse.success({
        message: draftPostFailed
          ? 'Approval submitted successfully, but draft posting failed and still needs retry'
          : 'Approval submitted successfully',
        data: result,
      })
    );
  } catch (error) {
    next(error);
  }
});

function notImplemented(message) {
  return (_req, res) => {
    res.status(501).json(
      apiResponse.error({
        message,
        statusCode: 501,
      })
    );
  };
}

router.post('/raw', notImplemented('Raw SAP forwarding is not implemented yet.'));
router.get('/entity-metadata/:entity', notImplemented('Entity metadata inspection is not implemented yet.'));
router.post('/action-metadata/:action', notImplemented('Action metadata inspection is not implemented yet.'));
router.post('/discover-approval', notImplemented('Approval discovery is not implemented yet.'));

export default router;
