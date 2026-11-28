// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  inpTargetsByTemplate,
  inpUnknownShare,
  templateOfPath,
} from '../scripts/lib/cwv-attribution.mjs';
import {
  INP_UNKNOWN_GATE_FROM,
  INP_UNKNOWN_MAX_SHARE,
  INP_UNKNOWN_MIN_EVENTS,
  renderReport,
} from '../scripts/cwv-attribution-report.mjs';

/** INP target x template x device and the unknown share (issue 20410). */
const valued = (path: string, selector: string, device: string, value: number, count: number) => ({
  path, section: 'inp', component: 'main', action: 'pointer', selector, ac: 0, cc: 0, value, device, count,
});
const plain = (selector: string, count: number) => ({
  path: '/cerca-lavoro-ticino/', section: 'inp', component: 'main', action: 'pointer', selector, ac: null, cc: null, count,
});

describe('INP report by template', () => {
  it('derives the page template from the path like the client', () => {
    expect(templateOfPath('/')).toBe('homepage');
    expect(templateOfPath('/cerca-lavoro-ticino/')).toBe('jobs_index');
    expect(templateOfPath('/cerca-lavoro-ticino/annuncio-di-prova-123/')).toBe('job_detail');
    expect(templateOfPath('/cerca-lavoro-ticino/azienda-esempio/')).toBe('jobs_company');
  });

  it('groups selector x template x device and sums paths of the same template', () => {
    const rows = [
      valued('/cerca-lavoro-ticino/annuncio-a/', 'article.job-card', 'mobile', 300, 4),
      valued('/cerca-lavoro-ticino/annuncio-b/', 'article.job-card', 'mobile', 500, 6),
      valued('/cerca-lavoro-ticino/annuncio-b/', 'article.job-card', 'desktop', 250, 2),
      valued('/cerca-lavoro-ticino/', 'article.job-card', 'mobile', 400, 1),
    ];
    const grouped = inpTargetsByTemplate(rows);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toMatchObject({ selector: 'article.job-card', template: 'job_detail', device: 'mobile', count: 10 });
    expect(grouped.map((g: { template: string }) => g.template)).toContain('jobs_index');
  });

  it('computes the unknown share, legacy empty selector included', () => {
    const rows = [plain('unknown', 30), plain('', 10), plain('button.cta', 60)];
    expect(inpUnknownShare(rows)).toEqual({ unknown: 40, total: 100, share: 0.4 });
    expect(inpUnknownShare([])).toEqual({ unknown: 0, total: 0, share: 0 });
  });

  it('prints the unknown share and the template table', () => {
    const md = renderReport({
      window: { startDate: '2026-12-02', endDate: '2026-12-08' },
      attribution: [{ path: '/', section: 'inp', component: 'main', action: 'pointer', count: 60 }],
      selectors: [plain('unknown', 10), plain('button.cta', 90)],
      valuedSelectors: [valued('/cerca-lavoro-ticino/annuncio-a/', 'button.cta', 'mobile', 320, 5)],
      templates: [],
      coverage: {},
    });
    expect(md).toContain('Quota INP unknown: 10.0% (10/100 eventi)');
    expect(md).toContain('INP per bersaglio × template × device');
    expect(md).toMatch(/\| `button\.cta` \| job_detail \| mobile \|/);
  });

  it('pins the gate parameters: only stricter than the 77% that motivated it', () => {
    expect(INP_UNKNOWN_MAX_SHARE).toBe(0.3);
    expect(INP_UNKNOWN_MIN_EVENTS).toBeGreaterThan(0);
    expect(INP_UNKNOWN_GATE_FROM > '2026-11-28').toBe(true);
  });
});
