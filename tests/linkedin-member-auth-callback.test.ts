import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyOAuthCallback } from '../scripts/lib/oauth-callback-state.mjs';

const authScripts = [
  'scripts/linkedin-member-auth.mjs',
  'scripts/tiktok-auth.mjs',
  'scripts/reddit-auth.mjs',
].map((scriptPath) => ({
  path: scriptPath,
  source: fs.readFileSync(path.resolve(scriptPath), 'utf8'),
}));

function classify(query: string) {
  const params = new URLSearchParams(query);
  return classifyOAuthCallback(
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

    for (const { path: scriptPath, source } of authScripts) {
      const staleHandler = source.indexOf("if (callback.kind === 'stale')");
      const errorHandler = source.indexOf("if (callback.kind === 'error')");
      expect(staleHandler, scriptPath).toBeGreaterThanOrEqual(0);
      expect(errorHandler, scriptPath).toBeGreaterThan(staleHandler);
      expect(source.slice(staleHandler, errorHandler), scriptPath).not.toContain('server.close()');
    }
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
    for (const { path: scriptPath, source } of authScripts) {
      const invalidHandler = source.indexOf("if (callback.kind === 'invalid')");
      const successHandler = source.indexOf("res.end('Authorization received.", invalidHandler);
      expect(invalidHandler, scriptPath).toBeGreaterThanOrEqual(0);
      expect(successHandler, scriptPath).toBeGreaterThan(invalidHandler);
      expect(source.slice(invalidHandler, successHandler), scriptPath).not.toContain('server.close()');
    }
  });
});
