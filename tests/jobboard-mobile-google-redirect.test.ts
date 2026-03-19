import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('JobBoard mobile Google redirect flow', () => {
  it('persists the pending job across redirect and avoids marking redirect-start as cancelled auth', () => {
    const source = readFileSync(resolve(root, 'components/community/JobBoard.tsx'), 'utf8');

    expect(source).toContain("const JOB_AUTH_REDIRECT_SLUG_KEY = 'frontaliere_job_auth_redirect_slug';");
    expect(source).toContain('saveJobAuthRedirectSlug(deriveLocalizedJobSlug(redirectJob, locale));');
    expect(source).toContain("const redirectProvider = (() => {");
    expect(source).toContain("if (redirectProvider === provider) {");
    expect(source).toContain("if (initialJobSlug === redirectSlug) return;");
    expect(source).toContain('onJobRouteChange?.(redirectSlug);');
  });
});
