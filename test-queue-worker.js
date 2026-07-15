import { pollOnce, queueStore } from './src/services/queue/queueWorker.js';
import { query, end } from './src/db.js';

async function runVerification() {
  console.log('🧼 Cleaning local test environment...');
  await query('TRUNCATE TABLE email_approval_queue RESTART IDENTITY;');

  console.log('\n🔍 [TEST 1] Initial Poll Cycle Execution...');
  console.log('Expecting: Discovering active SAP approvals and inserting into the local DB.');
  await pollOnce();

  const pendingRows = await queueStore.getPendingItems();
  console.log(`📊 DB Status: Found ${pendingRows.length} item(s) pending processing inside your local DB.`);
  console.log(JSON.stringify(pendingRows, null, 2));

  if (pendingRows.length === 0) {
    console.warn('⚠️ Warning: No active SAP items matched criteria. Ensure an approval document exists with status "arsPending".');
    await end();
    return;
  }

  console.log('\n🔄 [TEST 2] Executing Immediate Duplicate Poll Cycle...');
  console.log('Expecting: De-duplication check ignores items already inside the local DB.');

  await pollOnce();

  const totalRowsResult = await query('SELECT COUNT(*) as count FROM email_approval_queue');
  const totalCount = parseInt(totalRowsResult.rows[0].count, 10);
  console.log(`📊 DB Status After Cycle 2: Total records = ${totalCount}`);

  if (totalCount === pendingRows.length) {
    console.log('✅ SUCCESS: De-duplication logic working correctly. 0 duplicate items were generated.');
  } else {
    console.error('❌ FAILURE: Double-enqueuing occurred! Duplicate unique entries were bypassed.');
  }

  await end();
  console.log('\n🏁 Verification tests finalized.');
}

runVerification().catch((error) => {
  console.error('Unexpected pipeline failure:', error);
  process.exit(1);
});
