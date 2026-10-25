import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('Google One Tap configuration', () => {
  it('opts into FedCM without calling unsupported prompt moment methods', () => {
    const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');

    expect(source).toContain('auto_select: true');
    expect(source).toContain('use_fedcm_for_prompt: true');
    expect(source).not.toMatch(/isNotDisplayed|isSkippedMoment|getNotDisplayedReason|getSkippedReason/);
    expect(source).toContain('disableAutoSelect');
  });

  it('mobile guard still protects signInWithGoogle popup flow', () => {
    const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');

    expect(source).toContain('function isMobileBrowserContext()');
  });
});
