import { describe, expect, it } from 'vitest';

import { socialCopyRevisionId } from '../scripts/lib/social-copy-revision.mjs';

describe('social copy revision fingerprint', () => {
  it('is stable for the exact hook/CTA pair and normalizes line endings only', () => {
    const first = socialCopyRevisionId({ copyHook: 'Traffico\r\nal valico', copyCta: 'Controlla ora' });
    expect(first).toMatch(/^[a-f0-9]{16}$/u);
    expect(socialCopyRevisionId({ copyHook: 'Traffico\nal valico', copyCta: 'Controlla ora' })).toBe(first);
    expect(socialCopyRevisionId({ copyHook: 'Traffico al valico', copyCta: 'Controlla ora' })).not.toBe(first);
    expect(socialCopyRevisionId({ copyHook: 'Traffico al valico', copyCta: 'Scopri di più' })).not.toBe(first);
  });

  it('does not fingerprint incomplete or unbounded text', () => {
    expect(socialCopyRevisionId({ copyHook: 'Only hook', copyCta: '' })).toBeNull();
    expect(socialCopyRevisionId({ copyHook: 'x'.repeat(513), copyCta: 'CTA' })).toBeNull();
  });
});
