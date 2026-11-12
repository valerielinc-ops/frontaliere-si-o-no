import { describe, expect, it } from 'vitest';
import { releaseExpiredArchiveRowAfterRender } from '../../build-plugins/shared/expiredArchiveRetention';

describe('expired archive progressive retention', () => {
  it('drops render-only fields and preserves cross-locale reconciliation metadata', () => {
    const slugByLocale = { it: 'it-slug', de: 'de-slug' };
    const row: Record<string, unknown> = {
      id: 'stable-id',
      slug: 'it-slug',
      slugByLocale,
      canton: 'TI',
      location: 'Lugano',
      title: 'Archived title',
      description: 'Large archived description',
      descriptionByLocale: { it: 'Italian copy', de: 'German copy' },
      requirements: ['First', 'Second'],
      company: 'Example AG',
    };

    const rows = [row];

    expect(releaseExpiredArchiveRowAfterRender(rows, 0, row, true)).toEqual({
      kind: 'compacted',
      fieldsReleased: 5,
    });
    expect(rows[0]).toBe(row);
    expect(row).toEqual({
      id: 'stable-id',
      slug: 'it-slug',
      slugByLocale,
      canton: 'TI',
      location: 'Lugano',
    });
  });

  it('removes a rendered archive row that has no cross-locale reader', () => {
    const row: Record<string, unknown> = {
      slug: 'single-locale',
      title: 'Archived title',
      description: 'Large archived description',
    };
    const rows = [row, { slug: 'pending' } as Record<string, unknown>];

    expect(releaseExpiredArchiveRowAfterRender(rows, 0, row, false)).toEqual({
      kind: 'removed',
      fieldsReleased: 0,
    });
    expect(rows).toEqual([null, { slug: 'pending' }]);
  });
});
