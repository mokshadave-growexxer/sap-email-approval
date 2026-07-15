// checkFields.js
import { sapSessionManager } from './src/sap/SapSessionManager.js';

await sapSessionManager.ensureLoggedIn();

const path =
  '/ApprovalRequests' +

  "?$filter=Status eq 'arsPending' and ObjectType eq '17' and IsDraft eq 'Y'" +

  '&$select=Code,Status,CurrentStage,ApprovalRequestLines';

try {
  const res = await sapSessionManager.client.get(path);
  const rows = res?.data?.value ?? res?.data ?? [];
  console.log(`Got ${rows.length} pending approval request(s).`);
  if (rows.length > 0) {
    console.log(JSON.stringify(rows[0], null, 2));
  }
} catch (e) {
  console.log(JSON.stringify(e.response?.data, null, 2));
}