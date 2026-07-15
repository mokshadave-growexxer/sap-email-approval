import { apiResponse } from '../utils/apiResponse.js';
import { sapSessionManager } from '../sap/SapSessionManager.js';

export const healthSapCheck = async (req, res, next) => {
  try {
    const session = await sapSessionManager.ensureLoggedIn();

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
};
