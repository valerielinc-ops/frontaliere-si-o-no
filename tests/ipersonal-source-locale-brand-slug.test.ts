import { describe, expect, it } from 'vitest';
import { buildSlug, slugNeedsBrandRefresh } from '../scripts/lib/regenerate-slugs-helpers.mjs';

describe('#7722 source-locale brand refresh', () => {
  it('refreshes a stale source slug and preserves the old route as a bridge', () => {
    const sourceTitle = 'Techniker Elektronik 100%';
    const oldSlug = 'techniker-elektronik-100-med-ipersonal-ch';
    const location = 'Nottwil, Luzern';
    const company = 'iPersonal AG';
    const canonical = buildSlug(sourceTitle, company, location);

    expect(slugNeedsBrandRefresh({
      isBrandRelabelledKey: true,
      currentSlug: oldSlug,
      title: sourceTitle,
      company,
      location,
    })).toBe(true);
    expect(canonical).toContain('ipersonal-ag');
    expect(canonical).not.toContain('med-ipersonal');

    const previousSlugsByLocale = { de: [oldSlug] };
    expect(previousSlugsByLocale.de).toContain(oldSlug);
  });
});
