import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('PostHog metadata Remote Config scope', () => {
  it('writes existing query metadata only to the server namespace with ETag protection', () => {
    const source = readFileSync(resolve(ROOT, 'scripts/set-posthog-rc.mjs'), 'utf8');

    expect(source).toContain('namespace: RC_SERVER_NAMESPACE');
    expect(source).toContain('updateRcTemplateWithEtag');
    expect(source).toContain('stageRcParamValue(next, name, value, description)');
    expect(source).toContain('SERVER_POSTHOG_PROJECT_ID');
    expect(source).toContain('SERVER_POSTHOG_HOST');
    expect(source).not.toContain('fetchRcTemplate');
    expect(source).not.toContain('publishRcTemplate');
  });
});
