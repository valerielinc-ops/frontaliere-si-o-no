import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyLinkedInMemberAuthCallback } from '../scripts/lib/linkedin-member-auth-callback.mjs';

const authScript = fs.readFileSync(path.resolve('scripts/linkedin-member-auth.mjs'), 'utf8');

function classify(query: string) {
  const params = new URLSearchParams(query);
  return classifyLinkedInMemberAuthCallback(
    {
      code: params.get('code'),
      error: params.get('error'),
      state: params.get('state'),
    },
    'current-state',
  );
}

describe('LinkedIn member OAuth callback state', () => {
  it('ignores an old error callback instead of terminating the current flow', () => {
    expect(classify('error=unauthorized_scope_error&state=old-state')).toEqual({ kind: 'stale' });

    const staleHandler = authScript.indexOf("if (callback.kind === 'stale')");
    const errorHandler = authScript.indexOf("if (callback.kind === 'error')");
    expect(staleHandler).toBeGreaterThanOrEqual(0);
    expect(errorHandler).toBeGreaterThan(staleHandler);
    expect(authScript.slice(staleHandler, errorHandler)).not.toContain('server.close()');
  });

  it('rejects an OAuth error only when it carries the active state', () => {
    expect(classify('error=access_denied&state=current-state')).toEqual({
      kind: 'error',
      error: 'access_denied',
    });
  });

  it('accepts a code only with the active state', () => {
    expect(classify('code=authorization-code&state=current-state')).toEqual({
      kind: 'success',
      code: 'authorization-code',
    });
    expect(classify('code=authorization-code&state=old-state')).toEqual({ kind: 'stale' });
  });

  it('keeps a matching but incomplete callback from closing the active flow', () => {
    expect(classify('state=current-state')).toEqual({ kind: 'invalid' });
    const invalidHandler = authScript.indexOf("if (callback.kind === 'invalid')");
    const successHandler = authScript.indexOf("res.end('Authorization received.", invalidHandler);
    expect(invalidHandler).toBeGreaterThanOrEqual(0);
    expect(successHandler).toBeGreaterThan(invalidHandler);
    expect(authScript.slice(invalidHandler, successHandler)).not.toContain('server.close()');
  });
});
