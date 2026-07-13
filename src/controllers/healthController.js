import { apiResponse } from '../utils/apiResponse.js';

export const healthCheck = (req, res) => {
  res.status(200).json(
    apiResponse.success({
      message: 'Service is healthy',
      data: {
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      },
    })
  );
};
