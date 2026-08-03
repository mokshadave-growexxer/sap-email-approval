import logger from '../config/logger.js';
import { apiResponse } from '../utils/apiResponse.js';

export const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const response = apiResponse.error({
    message: err.message || 'Internal server error',
    errors: err.errors || null,
    statusCode,
  });

  // NEVER log req.body/req.query — request bodies can contain the approver's SAP
  // password and other secrets. Log only non-sensitive request metadata.
  logger.error('Unhandled error caught by middleware', {
    message: err.message,
    statusCode,
    stack: err.stack,
    route: req.path,
    method: req.method,
  });

  if (res.headersSent) {
    return next(err);
  }

  res.status(statusCode).json(response);
};
