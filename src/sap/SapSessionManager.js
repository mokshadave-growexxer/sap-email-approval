import axios from 'axios';
import https from 'https';
import { config } from '../config/index.js';

class SapSessionManager {
  constructor() {
    this.baseUrl = config.sap.baseUrl;
    this.username = config.sap.username;
    this.password = config.sap.password;
    this.companyDb = config.sap.companyDb;
    this.renewBeforeMs = config.sap.sessionRenewBeforeMs;
    this.cookies = new Map();
    this.lastLoginAt = null;
    this.sessionMeta = {
      version: '',
      company: '',
    };

    const httpsOptions = {};
    if (config.sap.rejectUnauthorized === false) {
      httpsOptions.rejectUnauthorized = false;
    }

    const clientOptions = {
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };

    if (Object.keys(httpsOptions).length) {
      clientOptions.httpsAgent = new https.Agent(httpsOptions);
    }

    this.client = axios.create(clientOptions);
  }

  get cookieHeader() {
    const cookiePairs = [];
    const sessionValue = this.cookies.get('B1SESSION');
    const routeValue = this.cookies.get('ROUTEID');

    if (sessionValue) {
      cookiePairs.push(`B1SESSION=${sessionValue}`);
    }

    if (routeValue) {
      cookiePairs.push(`ROUTEID=${routeValue}`);
    }

    return cookiePairs.join('; ');
  }

  isSessionValid() {
    return (
      this.cookies.has('B1SESSION') &&
      this.lastLoginAt !== null &&
      Date.now() - this.lastLoginAt < this.renewBeforeMs
    );
  }

  parseCookies(setCookieHeaders) {
    const cookieHeaders = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : typeof setCookieHeaders === 'string'
      ? [setCookieHeaders]
      : [];

    cookieHeaders.forEach((cookieString) => {
      const [cookiePair] = cookieString.split(';');
      const [name, value] = cookiePair.split('=');
      if (!name || !value) {
        return;
      }

      const cookieName = name.trim();
      const cookieValue = value.trim();

      if (cookieName === 'B1SESSION' || cookieName === 'ROUTEID') {
        this.cookies.set(cookieName, cookieValue);
      }
    });
  }

  setRequestCookies() {
    const headerValue = this.cookieHeader;
    if (headerValue) {
      this.client.defaults.headers.Cookie = headerValue;
    } else {
      delete this.client.defaults.headers.Cookie;
    }
  }

  async login() {
    if (!this.username || !this.password || !this.companyDb) {
      throw new Error('SAP Service Layer credentials are not configured');
    }

    const payload = {
      UserName: this.username,
      Password: this.password,
      CompanyDB: this.companyDb,
    };

    const response = await this.client.post('/Login', payload);

    if (response.status !== 200 || !response.data) {
      throw new Error('Unable to authenticate with SAP Service Layer');
    }

    this.parseCookies(response.headers['set-cookie']);
    this.lastLoginAt = Date.now();
    this.sessionMeta = {
      version: response.data.Version ?? '',
      company: response.data.CompanyName ?? '',
    };
    this.setRequestCookies();

    return {
      version: this.sessionMeta.version,
      company: this.sessionMeta.company,
    };
  }

  async logout() {
    if (!this.cookies.has('B1SESSION')) {
      this.clearSession();
      return false;
    }

    this.setRequestCookies();

    try {
      await this.client.post('/Logout');
    } catch (error) {
      // If logout fails, continue clearing local session state.
    }

    this.clearSession();
    return true;
  }

  clearSession() {
    this.cookies.clear();
    this.lastLoginAt = null;
    this.sessionMeta = { version: '', company: '' };
    delete this.client.defaults.headers.Cookie;
  }

  async ensureLoggedIn() {
    if (this.isSessionValid()) {
      return {
        version: this.sessionMeta.version,
        company: this.sessionMeta.company,
      };
    }

    await this.logout();
    return this.login();
  }
}

export const sapSessionManager = new SapSessionManager();
