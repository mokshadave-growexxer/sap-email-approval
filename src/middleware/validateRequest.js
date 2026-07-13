import { validationResult } from 'express-validator';
import { apiResponse } from '../utils/apiResponse.js';

export const validateRequest = (req, res, next) => {
  const errors = validationResult(req);

  if (errors.isEmpty()) {
    return next();
  }

  return res.status(400).json(
    apiResponse.error({
      message: 'Validation failed',
      statusCode: 400,
      errors: errors.array().map((error) => ({
        field: error.param,
        message: error.msg,
      })),
    })
  );
};
