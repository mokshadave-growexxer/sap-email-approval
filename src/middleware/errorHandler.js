import logger from '../config/logger.js';
import { apiResponse } from '../utils/apiResponse.js';

export const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const response = apiResponse.error({
    message: err.message || 'Internal server error',
    errors: err.errors || null,
    statusCode,
  });

  logger.error('Unhandled error caught by middleware', {
    message: err.message,
    statusCode,
    stack: err.stack,
    route: req.originalUrl,
    method: req.method,
    body: req.body,
    query: req.query,
  });

  if (res.headersSent) {
    return next(err);
  }

  res.status(statusCode).json(response);
};
