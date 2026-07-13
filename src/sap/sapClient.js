import axios from 'axios';
import { config } from '../config/index.js';

export const sapClient = axios.create({
  baseURL: config.sap.baseUrl,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});
