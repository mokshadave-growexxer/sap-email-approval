import test from 'node:test';
import assert from 'node:assert/strict';
import { groupActionableByApprover } from '../src/services/digest/digestService.js';
import { config, intOrFallback } from '../src/config/index.js';

// The "stage" is the sequential position of the current actionable approver, so it
// works whether approvers sit on distinct StageCodes or share one StageCode as
// sequential lines (the real setup — the earlier StageCode-based logic sent every
// same-code approver at the stage-1 time).
function pending() {
  return [
    // Stage 1: first approver (UserID 11) still pending, same StageCode as the 2nd.
    {
      Code: 201,
      Status: 'arsPending',
      CurrentStage: 1,
      ObjectEntry: 0,
      DraftEntry: 5,
      CreationDate: '2026-09-12',
      ApprovalRequestLines: [
        { UserID: 11, StageCode: 1, Status: 'ardPending' },
        { UserID: 22, StageCode: 1, Status: 'ardPending' },
      ],
    },
    // Stage 2: first approver approved, now awaiting the 2nd approver — SAME StageCode.
    {
      Code: 202,
      Status: 'arsPending',
      CurrentStage: 1,
      ObjectEntry: 0,
      DraftEntry: 6,
      CreationDate: '2026-09-12',
      ApprovalRequestLines: [
        { UserID: 11, StageCode: 1, Status: 'ardApproved' },
        { UserID: 22, StageCode: 1, Status: 'ardPending' },
      ],
    },
    // Stage 2 via a distinct StageCode also resolves to position 2.
    {
      Code: 203,
      Status: 'arsPending',
      CurrentStage: 2,
      ObjectEntry: 0,
      DraftEntry: 7,
      CreationDate: '2026-09-12',
      ApprovalRequestLines: [
        { UserID: 11, StageCode: 1, Status: 'ardApproved' },
        { UserID: 22, StageCode: 2, Status: 'ardPending' },
      ],
    },
  ];
}

test('stageFilter=1 groups only SOs awaiting the first approver', () => {
  const byApprover = groupActionableByApprover(pending(), { createdCutoff: null, stageFilter: 1 });
  assert.deepEqual([...byApprover.keys()], ['11']);
  assert.deepEqual(
    byApprover.get('11').map((i) => i.approvalRequestId),
    [201]
  );
  assert.equal(byApprover.get('11')[0].stageNumber, 1);
});

test('stageFilter=2 groups SOs awaiting the second approver — same OR distinct StageCode', () => {
  const byApprover = groupActionableByApprover(pending(), { createdCutoff: null, stageFilter: 2 });
  assert.deepEqual([...byApprover.keys()], ['22']);
  assert.deepEqual(
    byApprover.get('22').map((i) => i.approvalRequestId).sort(),
    [202, 203]
  );
  assert.ok(byApprover.get('22').every((i) => i.stageNumber === 2));
});

test('no stageFilter includes every stage', () => {
  const byApprover = groupActionableByApprover(pending(), { createdCutoff: null });
  assert.equal(byApprover.size, 2);
});

test('a recorded @AP_APPROVAL level overrides the recomputed approverPosition', () => {
  // Request 202's actionable approver (UserID 22) would recompute to position 2,
  // but the level recorded when the instant channel first queued it says 1 —
  // e.g. it was queued before the request picked up an earlier approved line.
  // The recorded level must win so the stage-1 scheduler catches it, not stage-2.
  const levelsByKey = new Map([['202:22', 1]]);

  const stage1 = groupActionableByApprover(pending(), { createdCutoff: null, stageFilter: 1, levelsByKey });
  assert.deepEqual(
    stage1.get('22')?.map((i) => i.approvalRequestId),
    [202]
  );

  const stage2 = groupActionableByApprover(pending(), { createdCutoff: null, stageFilter: 2, levelsByKey });
  assert.deepEqual(
    stage2.get('22')?.map((i) => i.approvalRequestId),
    [203]
  );
});

test('intOrFallback parses ints and falls back on blank/non-numeric', () => {
  assert.equal(intOrFallback('4', 9), 4);
  assert.equal(intOrFallback('', 9), 9);
  assert.equal(intOrFallback('abc', 9), 9);
  assert.equal(intOrFallback(undefined, 9), 9);
});

test('config.digest.stageSchedules has one numeric-time entry per stage', () => {
  assert.equal(config.digest.stageSchedules.length, 2);
  assert.deepEqual(
    config.digest.stageSchedules.map((s) => s.stage),
    [1, 2]
  );
  for (const schedule of config.digest.stageSchedules) {
    assert.equal(typeof schedule.hour, 'number');
    assert.equal(typeof schedule.minute, 'number');
  }
});
