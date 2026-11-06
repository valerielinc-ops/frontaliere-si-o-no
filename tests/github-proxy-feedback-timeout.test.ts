import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../functions/src/githubProxy.js'), 'utf8');
const feedbackStart = source.indexOf('export async function handleCreateFeedbackIssue');
const adminStart = source.indexOf('// ── Admin: allowlisted GitHub calls');
const feedbackHandler = source.slice(feedbackStart, adminStart);

describe('feedback GitHub issue request', () => {
  it('uses a bounded deadline on the issue-creation POST', () => {
    expect(source).toContain('const FEEDBACK_GITHUB_TIMEOUT_MS = 20_000;');
    expect(feedbackHandler).toContain('signal: AbortSignal.timeout(FEEDBACK_GITHUB_TIMEOUT_MS)');
    expect(feedbackHandler.match(/\bfetch\(/g)).toHaveLength(1);
  });
});
