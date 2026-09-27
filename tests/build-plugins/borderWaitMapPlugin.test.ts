// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  renderPage,
  TICINO_MAP_CROSSINGS,
  type BorderWaitMapSnapshot,
} from '../../build-plugins/borderWaitMapPlugin';

describe('border wait map landing', () => {
  it('puts the live data before the long editorial copy', () => {
    const current: BorderWaitMapSnapshot = {
      updatedAt: '2026-09-27T06:08:57.019Z',
      perCrossing: {
        'chiasso-brogeda': {
          totalCrossingMinutes: 12,
          status: 'yellow',
          source: 'tomtom',
          lastUpdate: '2026-09-27T06:08:57.019Z',
        },
      },
    };
    const page = renderPage({ locale: 'it', dateStamp: '2026-09-27', current });
    const dataIndex = page.html.indexOf('bw-data-area');
    const editorialIndex = page.html.indexOf('bw-editorial');
    const faqIndex = page.html.lastIndexOf('Perché alcuni valichi');
    const longIntroIndex = page.html.indexOf('Questa pagina raccoglie la mappa live');

    expect(TICINO_MAP_CROSSINGS).toHaveLength(26);
    expect(dataIndex).toBeGreaterThan(-1);
    expect(editorialIndex).toBeGreaterThan(dataIndex);
    expect(editorialIndex).toBeGreaterThan(faqIndex);
    expect(longIntroIndex).toBeGreaterThan(editorialIndex);
    expect(page.html).toContain('data-bw-crossing=chiasso-brogeda');
    expect(page.html).toContain('data-bw-field=totalCrossingMinutes>12 min</strong>');
    expect(page.html).toContain('data-bw-field=status aria-label=Stato>Moderata</span>');
    expect(page.html).toContain('data-bw-field=source>TomTom</span>');
    expect(page.html).toContain('data-bw-live-badge');
    expect(page.html).toContain('border-wait-hydrate.js');
    expect(page.html).toContain('Valichi monitorati</div><div class=s-tval>26</div>');
  });
});
