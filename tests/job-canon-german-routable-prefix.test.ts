import { describe, expect, it } from 'vitest';
import { routableGermanJobCanonPrefix } from '../build-plugins/jobCanonRedirectMapPlugin';

describe('routableGermanJobCanonPrefix', () => {
  it('rewrites a known legacy German canton section to the canonical one', () => {
    expect(routableGermanJobCanonPrefix('/de/jobs-im-zurich')).toBe('/de/jobs-in-zurich');
    expect(routableGermanJobCanonPrefix('/de/jobs-im-basel')).toBe('/de/jobs-in-basel');
    expect(routableGermanJobCanonPrefix('/de/jobs-im-genf')).toBe('/de/jobs-in-genf');
  });

  it('keeps routable prefixes unchanged', () => {
    expect(routableGermanJobCanonPrefix('/de/jobs-in-zurich')).toBe('/de/jobs-in-zurich');
    expect(routableGermanJobCanonPrefix('/de/jobs-im-tessin')).toBe('/de/jobs-im-tessin');
    expect(routableGermanJobCanonPrefix('/de/jobs-im-aargau')).toBe('/de/jobs-im-aargau');
    expect(routableGermanJobCanonPrefix('/cerca-lavoro-zurigo')).toBe('/cerca-lavoro-zurigo');
  });

  it('drops an unknown legacy section instead of emitting a 301 to a 404', () => {
    expect(routableGermanJobCanonPrefix('/de/jobs-im-atlantis')).toBeNull();
  });
});
