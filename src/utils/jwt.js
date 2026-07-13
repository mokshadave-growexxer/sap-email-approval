import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

export const signToken = (payload, options = {}) => {
  return jwt.sign(payload, config.jwtSecret, {
    algorithm: 'HS512',
    expiresIn: config.jwtExpiresIn,
    ...options,
  });
};

export const verifyToken = (token) => {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS512'] });
};
