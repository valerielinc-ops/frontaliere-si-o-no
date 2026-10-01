import { describe, expect, it } from 'vitest';
import { capTitle70 } from '../../build-plugins/staticPagesPlugin';
import { escapeForBudget, TITLE_MAX_CHARS } from '../../build-plugins/shared/titleSuffix';

describe('static metadata title cap', () => {
  it('caps the serialized title after HTML escaping special characters', () => {
    const source = `${'N'.repeat(70)} &A<Z>"`;
    const rawTitle = capTitle70(source, '/fixture/static-special-title');
    const serialized = `<title>${escapeForBudget(rawTitle)}</title>`;
    const extracted = serialized.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';

    expect(extracted.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });
});
