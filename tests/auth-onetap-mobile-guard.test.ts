import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('Google One Tap configuration', () => {
  it('uses auto_select while leaving the deprecated FedCM prompt flag out', () => {
    const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');

    expect(source).toContain('auto_select: true');
    expect(source).not.toContain('use_fedcm_for_prompt');
    expect(source).toContain('disableAutoSelect');
  });

  it('mobile guard still protects signInWithGoogle popup flow', () => {
    const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');

    expect(source).toContain('function isMobileBrowserContext()');
  });
});
