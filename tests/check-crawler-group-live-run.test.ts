import { describe, expect, it, vi } from 'vitest';
import { hasLiveRun, parseArgs } from '../scripts/check-crawler-group-live-run.mjs';

describe('cross-entry crawler live-run guard', () => {
  it('uses the corpus workflow and token defaults, with explicit overrides available', () => {
    expect(parseArgs(['crawler-group-19.yml'])).toEqual({
      groupFile: 'crawler-group-19.yml',
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      tokenEnv: 'GITHUB_PAT_NANAKO',
    });
    expect(parseArgs([
      'crawler-group-19.yml',
      '--repo', 'valerielinc-ops/frontaliere-si-o-no',
      '--token-env', 'GITHUB_PAT',
    ])).toEqual({
      groupFile: 'crawler-group-19.yml',
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      tokenEnv: 'GITHUB_PAT',
    });
  });

  it('blocks when the other entry point is queued or active', () => {
    const gh = vi.fn().mockReturnValue(JSON.stringify([
      { status: 'completed' },
      { status: 'waiting' },
    ]));

    expect(hasLiveRun('crawler-group-19.yml', {
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: 'token-for-test',
      gh,
    })).toBe(true);
    expect(gh).toHaveBeenCalledWith(
      'gh',
      [
        'run', 'list',
        '-w', 'crawler-group-19.yml',
        '-R', 'nanakokyobashi-rgb/frontaliere-articles',
        '-L', '10',
        '--json', 'status',
      ],
      expect.objectContaining({
        encoding: 'utf8',
        env: expect.objectContaining({ GH_TOKEN: 'token-for-test' }),
      }),
    );
  });

  it('does not block once all runs have completed', () => {
    const gh = vi.fn().mockReturnValue(JSON.stringify([
      { status: 'completed' },
      { status: 'cancelled' },
      { status: 'failure' },
    ]));

    expect(hasLiveRun('crawler-group-19.yml', {
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: 'token-for-test',
      gh,
    })).toBe(false);
  });

  it('proceeds safely when credentials, gh, or JSON data are unavailable', () => {
    const gh = vi.fn().mockImplementation(() => {
      throw new Error('gh unavailable');
    });

    expect(hasLiveRun('crawler-group-19.yml', {
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: '',
      gh,
    })).toBe(false);
    expect(gh).not.toHaveBeenCalled();

    expect(hasLiveRun('crawler-group-19.yml', {
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: 'token-for-test',
      gh,
    })).toBe(false);

    const malformed = vi.fn().mockReturnValue('{not-json');
    expect(hasLiveRun('crawler-group-19.yml', {
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: 'token-for-test',
      gh: malformed,
    })).toBe(false);
  });
});
