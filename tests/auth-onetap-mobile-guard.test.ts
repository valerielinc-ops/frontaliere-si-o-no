import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('Google One Tap configuration', () => {
  it('uses auto_select for silent sign-in and disables FedCM prompt mode', () => {
    const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');

    expect(source).toContain('auto_select: true');
    expect(source).toContain('use_fedcm_for_prompt: false');
  });

  it('mobile guard still protects signInWithGoogle popup flow', () => {
    const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');

    expect(source).toContain('function isMobileBrowserContext()');
  });
});
