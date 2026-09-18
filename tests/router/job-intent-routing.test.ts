import { describe, expect, it } from 'vitest';
import { parsePath } from '@/services/router';

describe('job intent landing routing', () => {
  it('keeps the canonical Ticino intent URL as a static overlay', () => {
    const parsed = parsePath('/cerca-lavoro-ticino/lavoro-tedesco-ticino/');

    expect(parsed).toMatchObject({
      locale: 'it',
      route: {
        activeTab: 'job-board',
        jobBoardCanton: 'TI',
        staticOverlay: true,
      },
    });
    expect(parsed.redirectTo).toBeUndefined();
  });

  it('redirects a Ticino intent slug written in another locale to its localized page', () => {
    const parsed = parsePath('/en/find-jobs-ticino/lavoro-tedesco-ticino/');

    expect(parsed.redirectTo).toBe('/en/find-jobs-ticino/german-speaking-jobs-ticino/');
    expect(parsed.route.jobBoardCanton).toBe('TI');
    expect(parsed.route.staticOverlay).toBe(true);
  });

  it('redirects intent pages nested under another canton to the emitted Ticino page', () => {
    const parsed = parsePath('/cerca-lavoro-san-gallo/lavoro-tedesco-ticino/');

    expect(parsed.redirectTo).toBe('/cerca-lavoro-ticino/lavoro-tedesco-ticino/');
    expect(parsed.route.jobBoardCanton).toBe('TI');
    expect(parsed.route.staticOverlay).toBe(true);
  });
});
