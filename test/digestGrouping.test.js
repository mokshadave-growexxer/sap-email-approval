import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupActionableByApprover,
  isDigestAllowedRecipient,
  computeOrderValue,
  deriveCurrency,
} from '../src/services/digest/digestService.js';

function pending() {
  return [
    {
      Code: 101,
      Status: 'arsPending',
      CurrentStage: 1,
      ObjectEntry: 0,
      DraftEntry: 55,
      CreationDate: '2026-09-12',
      ApprovalRequestLines: [{ UserID: 11, StageCode: 1, Status: 'ardPending' }],
    },
    {
      Code: 102,
      Status: 'arsPending',
      CurrentStage: 1,
      ObjectEntry: 900, // existing doc -> UPDATED
      DraftEntry: 56,
      CreationDate: '2026-09-12',
      ApprovalRequestLines: [{ UserID: 11, StageCode: 1, Status: 'ardPending' }],
    },
    {
      Code: 103,
      Status: 'arsPending',
      CurrentStage: 2,
      DraftEntry: 57,
      CreationDate: '2026-09-12',
      // First line at stage 2 is a different approver; UserID 11 is not actionable here.
      ApprovalRequestLines: [
        { UserID: 99, StageCode: 1, Status: 'ardApproved' },
        { UserID: 22, StageCode: 2, Status: 'ardPending' },
      ],
    },
  ];
}

test('groups actionable SOs by the current approver, with badge and fields', () => {
  const byApprover = groupActionableByApprover(pending(), { createdCutoff: '2026-09-10' });

  const forEleven = byApprover.get('11');
  assert.equal(forEleven.length, 2);
  assert.deepEqual(
    forEleven.map((i) => i.approvalRequestId),
    [101, 102]
  );
  assert.equal(forEleven[0].changeType, 'CREATED');
  assert.equal(forEleven[1].changeType, 'UPDATED');
  assert.equal(forEleven[0].draftEntry, 55);

  const forTwentyTwo = byApprover.get('22');
  assert.equal(forTwentyTwo.length, 1);
  assert.equal(forTwentyTwo[0].approvalRequestId, 103);
});

test('the created-date cutoff excludes older requests before grouping', () => {
  const older = pending().map((r) => ({ ...r, CreationDate: '2026-09-01' }));
  const byApprover = groupActionableByApprover(older, { createdCutoff: '2026-09-10' });
  assert.equal(byApprover.size, 0);
});

test('a null cutoff keeps every request', () => {
  const byApprover = groupActionableByApprover(pending(), { createdCutoff: null });
  assert.equal(byApprover.size, 2); // approvers 11 and 22
});

test('isDigestAllowedRecipient matches case-insensitively against the allowlist', () => {
  const allow = ['moksha.dave@growexx.com'];
  assert.equal(isDigestAllowedRecipient('Moksha.Dave@Growexx.com', allow), true);
  assert.equal(isDigestAllowedRecipient('someone@else.com', allow), false);
  assert.equal(isDigestAllowedRecipient('', allow), false);
  assert.equal(isDigestAllowedRecipient(null, allow), false);
});

test('computeOrderValue sums quantity x price across lines', () => {
  const lines = [
    { Quantity: 10, Price: 2.5 },
    { Quantity: 4, UnitPrice: 1.25 },
    { Quantity: 'x', Price: 5 }, // non-numeric quantity contributes 0
  ];
  assert.equal(computeOrderValue(lines), 30);
});

test('deriveCurrency reads the first line currency', () => {
  assert.equal(deriveCurrency([{ Currency: 'USD' }, { Currency: 'EUR' }]), 'USD');
  assert.equal(deriveCurrency([]), '');
});
