import { describe, expect, it } from 'vitest';
import { CompactLocalePathClaims } from '../../build-plugins/shared/compactLocalePathClaims';
import { CompactStringHashSet } from '../../build-plugins/shared/compactStringHashSet';

describe('compact build registries', () => {
  it('keeps exact route claims while normalising slashes', () => {
    const claims = new CompactLocalePathClaims();

    expect(claims.claim('/de/jobs-in-zurich/company-northstar/')).toBe(true);
    expect(claims.claim('de/jobs-in-zurich/company-northstar')).toBe(false);
    expect(claims.has('/de/jobs-in-zurich/company-northstar/')).toBe(true);
    expect(claims.has('/de/jobs-in-zurich/company-northstar-city/')).toBe(false);
    expect(claims.has('/it/jobs-in-zurich/company-northstar/')).toBe(false);
    expect(claims.size).toBe(1);

    claims.clear();
    expect(claims.size).toBe(0);
    expect(claims.has('/de/jobs-in-zurich/company-northstar/')).toBe(false);
  });

  it('retains membership for a large title registry without retaining title strings', () => {
    const claims = new CompactStringHashSet();
    const titles = Array.from({ length: 20_000 }, (_, index) =>
      `role ${index} — employer ${index % 97} in city ${index % 311}`,
    );

    for (const title of titles) expect(claims.add(title)).toBe(true);
    for (const title of titles) expect(claims.has(title)).toBe(true);
    expect(claims.size).toBeLessThanOrEqual(titles.length);

    claims.clear();
    expect(claims.size).toBe(0);
    expect(claims.has(titles[0])).toBe(false);
  });
});
