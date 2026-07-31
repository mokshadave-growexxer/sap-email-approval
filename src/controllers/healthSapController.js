import { apiResponse } from '../utils/apiResponse.js';
import { listCompanies, runInCompany, currentSL } from '../services/company/companyContext.js';

export const healthSapCheck = async (req, res, next) => {
  try {
    const companies = await Promise.all(
      listCompanies().map((company) =>
        runInCompany(company, async () => {
          try {
            const session = await currentSL().ensureLoggedIn();
            return { key: company.key, connected: true, version: session.version, company: session.company };
          } catch (error) {
            return { key: company.key, connected: false, error: error?.message || String(error) };
          }
        })
      )
    );

    const allConnected = companies.every((c) => c.connected);
    res.status(allConnected ? 200 : 503).json(
      apiResponse.success({
        message: allConnected ? 'SAP Service Layer connections are healthy' : 'One or more SAP companies are unreachable',
        data: { companies },
      })
    );
  } catch (error) {
    next(error);
  }
};
