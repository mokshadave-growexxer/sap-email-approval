import { query, table } from './src/services/sap/hanaClient.js';
import { getDraftAttachments } from './src/services/sap/attachmentService.js';
import { listCompanies, runInCompany } from './src/services/company/companyContext.js';

async function run() {
  try {
    const companies = listCompanies();
    if (!companies.length) {
      console.log('No companies found.');
      process.exit(1);
    }
    const company = companies[0];
    console.log(`Using company: ${company.key}`);
    
    await runInCompany(company, async () => {
      console.log('Fetching recent drafts with attachments...');
      const rows = await query(`
        SELECT TOP 5 T0."DocEntry"
        FROM ${table('ODRF')} T0
        JOIN ${table('ATC1')} T2 ON T0."AtcEntry" = T2."AbsEntry"
        ORDER BY T0."DocEntry" DESC
      `);
      console.log('Found recent Drafts:', rows.map(r => r.DocEntry));
      for (const r of rows) {
        console.log(`\n--- Checking attachments for Draft ${r.DocEntry} ---`);
        await getDraftAttachments(r.DocEntry);
      }
    });
  } catch(e) {
    console.error('Error:', e);
  }
  process.exit(0);
}
run();
