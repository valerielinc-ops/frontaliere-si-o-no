// @vitest-environment node
//
// P1 noindex plan (2026-10-24): an upcoming event detail stays indexable while
// Search Console has shown one of its four locale URLs in 90 days, or while it
// belongs to a border canton (TI/GR/VS). Past details are the permanent event
// archive and remain indexable regardless of demand when they clear the shared
// content floor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILD_DATE_STAMP } from '../build-plugins/constants';
import { eventsSeoPagesPlugin, pathForEventDetail } from '../build-plugins/eventsSeoPagesPlugin';
import { reset } from '../build-plugins/sharedWriteRegistry';
import { replaceEmittedEventArchivePaths } from '../build-plugins/shared/eventArchiveCompat';
import { _resetForTests as resetTrafficEvidence, GSC_DEMAND_MIN_IMPRESSED_PATHS, GSC_DEMAND_WINDOW_DAYS } from '../build-plugins/shared/trafficEvidenceFilter';

const fixtures = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../scripts/lib/events-utils.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/events-utils.mjs')>();
  return { ...actual, loadEventsDataset: (file?: string) => ({ events: file ? [] : fixtures.events, totalEvents: file ? 0 : fixtures.events.length }) };
});
vi.mock('../build-plugins/shared/buildSignals', () => ({ staticPagesFlushed: Promise.resolve() }));

const roots: string[] = [];
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'events-demand-gate-')); roots.push(root); return root; };
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  fixtures.events = [];
  reset();
  replaceEmittedEventArchivePaths([]);
  resetTrafficEvidence();
});

const day = (offset: number) => new Date(Date.parse(`${BUILD_DATE_STAMP}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const event = (key: string, canton: string, comune: string, offset: number) => ({
  id: `fixture-agenda:${key}`, title: `Rassegna ${key}`, description: `Rassegna ${key}: concerti, mercato e visite guidate nel centro storico.`,
  startDate: day(offset), endDate: day(offset), canton, comune,
  url: `https://agenda.example.ch/${key}`, sourceKey: 'fixture-agenda', sourceName: 'Agenda di prova',
});
const FIXTURE = [
  event('ti-upcoming', 'TI', 'Lugano', 5),
  event('ti-past', 'TI', 'Lugano', -30),
  event('ge-upcoming', 'GE', 'Lancy', 5),
  event('ge-shown', 'GE', 'Lancy', 6),
  event('ge-past', 'GE', 'Lancy', -30),
];

async function emit(root: string) {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fixtures.events = FIXTURE.map((ev) => ({ ...ev }));
  reset();
  replaceEmittedEventArchivePaths([]);
  resetTrafficEvidence();
  const close = eventsSeoPagesPlugin(root).closeBundle;
  if (typeof close !== 'function') throw new Error('Expected the normal event producer hook');
  await close.call({} as never);
}

/** Italian detail pages by fixture key → { urlPath, html }. */
function itDetails(distDir: string): Map<string, { urlPath: string; html: string }> {
  const out = new Map<string, { urlPath: string; html: string }>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name !== 'index.html') continue;
      const html = fs.readFileSync(full, 'utf8');
      if (!/data-events-page=["']?event_detail\b/.test(html)) continue;
      const urlPath = `/${path.relative(distDir, path.dirname(full)).split(path.sep).join('/')}/`;
      if (/^\/(en|de|fr)\//.test(urlPath)) continue;
      const key = FIXTURE.map((ev) => ev.id.split(':')[1]).find((k) => urlPath.includes(`/rassegna-${k}-`));
      if (key) out.set(key, { urlPath, html });
    }
  };
  walk(distDir);
  return out;
}

const robotsOf = (html: string) => html.match(/<meta[^>]*\bname=["']?robots["']?[^>]*\bcontent=["']?([^"'>]+)/i)?.[1]?.replace(/\s+/g, '');

describe('event detail demand gate (P1 noindex plan)', () => {
  it('keeps every detail indexable while the demand evidence is dormant', async () => {
    const root = temporary();
    await emit(root);
    const details = itDetails(path.join(root, 'dist'));
    expect([...details.keys()].sort()).toEqual(['ge-past', 'ge-shown', 'ge-upcoming', 'ti-past', 'ti-upcoming']);
    for (const [key, { html }] of details) expect(robotsOf(html), key).not.toMatch(/noindex/);
  });

  it('noindexes upcoming details without demand, while keeping rich past archive entries indexable', async () => {
    const discovery = temporary();
    await emit(discovery);
    const shownIt = itDetails(path.join(discovery, 'dist')).get('ge-shown')!.urlPath;
    // Search Console showed the EN alternate of ge-shown only: the whole
    // hreflang group must stay indexable.
    const shownSlug = shownIt.split('/').filter(Boolean).pop()!;
    expect(pathForEventDetail('it', 'Lancy', shownSlug, 'GE')).toBe(shownIt);
    const shownEn = pathForEventDetail('en', 'Lancy', shownSlug, 'GE');

    const root = temporary();
    const pages: Record<string, number> = { [shownEn]: 4 };
    for (let index = 0; index < GSC_DEMAND_MIN_IMPRESSED_PATHS; index++) pages[`/fixture-impressed-${index}/`] = 1;
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'evidence-index.json'), JSON.stringify({ windowDays: GSC_DEMAND_WINDOW_DAYS, gsc: { pages } }));
    await emit(root);

    const details = itDetails(path.join(root, 'dist'));
    const sitemap = fs.readFileSync(path.join(root, 'dist', 'sitemap-eventi.xml'), 'utf8');
    const inSitemap = (urlPath: string) => sitemap.includes(`<loc>https://frontaliereticino.ch${urlPath}</loc>`);
    const expected: Record<string, boolean> = {
      'ti-upcoming': true, // border canton, upcoming
      'ge-shown': true, // Search Console demand on one locale
      'ti-past': true, // historical archive is exempt from the demand gate
      'ge-upcoming': false,
      'ge-past': true, // historical archive is exempt from the demand gate
    };
    for (const [key, indexable] of Object.entries(expected)) {
      const detail = details.get(key);
      expect(detail, key).toBeDefined();
      if (indexable) {
        expect(robotsOf(detail!.html), key).not.toMatch(/noindex/);
        expect(inSitemap(detail!.urlPath), key).toBe(true);
      } else {
        expect(robotsOf(detail!.html), key).toBe('noindex,follow');
        expect(inSitemap(detail!.urlPath), key).toBe(false);
      }
    }
  });
});
