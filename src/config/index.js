import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateEnv } from '../utils/validateEnv.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const env = validateEnv([
  { key: 'NODE_ENV', allowed: ['development', 'production', 'test'], default: 'development' },
  { key: 'PORT', parse: 'int', default: 3000 },
  { key: 'APP_NAME', default: 'sap-email-approval' },
  { key: 'JWT_SECRET' },
  { key: 'JWT_EXPIRES_IN', default: '15m' },
  { key: 'RATE_LIMIT_WINDOW_MS', parse: 'int', default: 15 * 60 * 1000 },
  { key: 'RATE_LIMIT_MAX', parse: 'int', default: 100 },
  { key: 'CORS_ORIGIN', default: '*' },
  { key: 'SAP_BASE_URL' },
  { key: 'SAP_USERNAME' },
  { key: 'SAP_PASSWORD' },
  { key: 'SMTP_HOST' },
  { key: 'SMTP_PORT', parse: 'int', default: 587 },
  { key: 'SMTP_USER' },
  { key: 'SMTP_PASS' },
]);

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  appName: env.APP_NAME,
  jwtSecret: env.JWT_SECRET,
  jwtExpiresIn: env.JWT_EXPIRES_IN,
  rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
  rateLimitMax: env.RATE_LIMIT_MAX,
  corsOrigin: env.CORS_ORIGIN,
  sap: {
    baseUrl: env.SAP_BASE_URL,
    username: env.SAP_USERNAME,
    password: env.SAP_PASSWORD,
  },
  smtp: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },
};
