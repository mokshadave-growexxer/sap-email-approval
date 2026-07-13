import { apiResponse } from '../utils/apiResponse.js';

export const notFoundHandler = (req, res) => {
  res.status(404).json(apiResponse.notFound('Endpoint not found'));
};
