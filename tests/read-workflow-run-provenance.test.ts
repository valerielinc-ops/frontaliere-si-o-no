import { describe, expect, it } from 'vitest';
import {
  readWorkflowRunProvenance,
  sourceRunViewArgs,
} from '../scripts/ci/read-workflow-run-provenance.mjs';

const sourceRun = {
  event: 'schedule',
  headBranch: 'main',
  headSha: 'a'.repeat(40),
  status: 'completed',
  conclusion: 'success',
};

describe('read-workflow-run-provenance', () => {
  it('retries an installation rate-limit response and returns the validated JSON object', () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = readWorkflowRunProvenance({
      runId: '43593862714',
      repository: 'valerielinc-ops/frontaliere-si-o-no',
      run: (args: string[]) => {
        expect(args).toEqual(sourceRunViewArgs('43593862714', 'valerielinc-ops/frontaliere-si-o-no'));
        attempts += 1;
        if (attempts < 3) {
          const error = new Error('gh failed');
          Object.assign(error, { stderr: 'HTTP 403: API rate limit exceeded for installation' });
          throw error;
        }
        return JSON.stringify(sourceRun);
      },
      retryOptions: {
        sleep: (delayMs: number) => delays.push(delayMs),
      },
    });

    expect(result).toEqual(sourceRun);
    expect(attempts).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it('does not retry authentication failures or accept malformed output', () => {
    let attempts = 0;
    expect(() => readWorkflowRunProvenance({
      runId: '123',
      repository: 'owner/repository',
      run: () => {
        attempts += 1;
        const error = new Error('gh failed');
        Object.assign(error, { stderr: 'HTTP 403: Bad credentials' });
        throw error;
      },
      retryOptions: { sleep: () => undefined },
    })).toThrow('Bad credentials');
    expect(attempts).toBe(1);

    expect(() => readWorkflowRunProvenance({
      runId: '123',
      repository: 'owner/repository',
      run: () => '[]',
    })).toThrow('source run response is invalid JSON');
  });
});
