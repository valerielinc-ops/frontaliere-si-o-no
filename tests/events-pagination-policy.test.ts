// @vitest-environment node
//
// P1 noindex plan (paginationIndexPolicy, 2026-10-24) on the two paginated
// event listings: the historical archive (`/eventi/archivio/page-N/`) and the
// overflow ladders (`<bucket>/page-N/`). Page 11+ ships `noindex,follow`; no
// page 2+ is listed in sitemap-eventi.xml.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_DATE_STAMP } from '../build-plugins/constants';
import {
  buildSitemap,
  historicalEventsArchivePath,
  overflowLadderPath,
  renderHistoricalEventsArchivePage,
} from '../build-plugins/eventsSeoPagesPlugin';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const distDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-pagination-')); roots.push(dir); return dir; };
const robotsOf = (html: string) => html.match(/<meta[^>]*\bname=["']?robots["']?[^>]*\bcontent=["']?([^"'>]+)/i)?.[1]?.replace(/\s+/g, '');

const day = (offset: number) => new Date(Date.parse(`${BUILD_DATE_STAMP}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const entries = Array.from({ length: 1200 }, (_, index) => ({
  event: {
    id: `fixture:${index}`, title: `Concerto d'archivio numero ${index}`, startDate: day(-30 - index), endDate: day(-30 - index),
    canton: 'TI', comune: 'Lugano', url: `https://agenda.example.ch/${index}`, sourceKey: 'fixture', sourceName: 'Agenda di prova',
  },
  canton: 'TI',
  comune: 'Lugano',
  slug: `concerto-archivio-${index}`,
}));

describe('events pagination policy (P1)', () => {
  it('keeps archive pages 1-10 on their content gate and ships page 11+ as noindex,follow', () => {
    const dir = distDir();
    const render = (page: number) => renderHistoricalEventsArchivePage({ locale: 'it', entries: entries as never, page, pageCount: 12, distDir: dir });
    const first = robotsOf(render(1).html);
    expect(first).not.toMatch(/noindex/);
    expect(robotsOf(render(10).html)).toBe(first);
    expect(robotsOf(render(11).html)).toBe('noindex,follow');
    expect(robotsOf(render(12).html)).toBe('noindex,follow');
  });

  it('lists only page 1 of the archive and no ladder page in sitemap-eventi.xml', () => {
    const xml = buildSitemap(
      [{ canton: 'TI', comuni: [], digests: [], hasOtherEvents: false, ladders: [] }],
      BUILD_DATE_STAMP,
      [],
      12,
    );
    expect(xml).toContain(`<loc>https://frontaliereticino.ch${historicalEventsArchivePath('it', 1)}</loc>`);
    for (const page of [2, 10, 11, 12]) {
      expect(xml).not.toContain(`<loc>https://frontaliereticino.ch${historicalEventsArchivePath('it', page)}</loc>`);
    }
    expect(xml).not.toContain(overflowLadderPath('it', 'TI', undefined, 2));
  });
});
