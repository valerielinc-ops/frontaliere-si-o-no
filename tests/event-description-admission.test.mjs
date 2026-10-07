import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEventDescriptionRewriteAdmission } from '../scripts/lib/event-description-admission.mjs';

test('admission rejects another active rewrite run but ignores the current run', () => {
  assert.deepEqual(assessEventDescriptionRewriteAdmission({
    currentRunId: '42',
    runs: [
      { databaseId: 42, status: 'in_progress' },
      { databaseId: 41, status: 'queued' },
    ],
  }), {
    admitted: false,
    reason: 'run-in-flight',
    detail: '41',
  });
  assert.deepEqual(assessEventDescriptionRewriteAdmission({
    currentRunId: '42',
    runs: [{ databaseId: 42, status: 'in_progress' }],
  }), { admitted: true, reason: 'admitted', detail: '' });
});

test('admission rejects only the reconciled open data PR', () => {
  assert.deepEqual(assessEventDescriptionRewriteAdmission({
    dataPullRequests: [
      { number: 12261, state: 'OPEN', headRefName: 'chore/event-description-rewrite', baseRefName: 'main' },
    ],
  }), {
    admitted: false,
    reason: 'data-pr-open',
    detail: '12261',
  });
  assert.deepEqual(assessEventDescriptionRewriteAdmission({
    dataPullRequests: [
      { number: 4, state: 'OPEN', headRefName: 'other-branch', baseRefName: 'main' },
      { number: 5, state: 'CLOSED', headRefName: 'chore/event-description-rewrite', baseRefName: 'main' },
    ],
  }), { admitted: true, reason: 'admitted', detail: '' });
});
