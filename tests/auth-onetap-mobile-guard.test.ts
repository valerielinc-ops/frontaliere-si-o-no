import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('Google One Tap mobile guard', () => {
  it('avoids auto-prompting One Tap on mobile and disables FedCM prompt mode', () => {
    const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');

    expect(source).toContain('function isMobileBrowserContext()');
    expect(source).toContain('if (isMobileBrowserContext()) return;');
    expect(source).toContain('auto_select: false');
    expect(source).toContain('use_fedcm_for_prompt: false');
  });
});
