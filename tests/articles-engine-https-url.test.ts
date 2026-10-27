import { describe, expect, it } from 'vitest';

import { httpsUrlOrNull } from '../packages/articles/engine/shared/httpsUrl.mjs';

describe('articles engine HTTPS URL contract', () => {
  it('accepts public HTTPS links and rejects embedded credentials', () => {
    expect(httpsUrlOrNull('https://example.org/source')).toBe('https://example.org/source');
    expect(httpsUrlOrNull('https://user:pass@example.org/source')).toBeNull();
    expect(httpsUrlOrNull('https://%75ser:pass@example.org/source')).toBeNull();
    expect(httpsUrlOrNull('//example.org/source')).toBeNull();
  });
});
