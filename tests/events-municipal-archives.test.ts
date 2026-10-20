// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { BUILD_DATE_STAMP } from '../build-plugins/constants';
import { eventsSeoPagesPlugin, pathFor, renderHistoricalEventsArchivePage } from '../build-plugins/eventsSeoPagesPlugin';
import { reset } from '../build-plugins/sharedWriteRegistry';
import { isEmittedEventArchivePath, replaceEmittedEventArchivePaths } from '../build-plugins/shared/eventArchiveCompat';
import { MAX_HTML_BYTES } from '../scripts/audit-page-weight.mjs';
import { allEndedEvents } from '../scripts/lib/events-retention.mjs';

const fixtures = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../scripts/lib/events-utils.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/events-utils.mjs')>();
  return { ...actual, loadEventsDataset: (file?: string) => ({ events: file ? [] : fixtures.events, totalEvents: file ? 0 : fixtures.events.length }) };
});
vi.mock('../build-plugins/shared/buildSignals', () => ({ staticPagesFlushed: Promise.resolve() }));

const roots: string[] = [];
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'municipal-events-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); fixtures.events = []; reset(); replaceEmittedEventArchivePaths([]); vi.unstubAllEnvs(); });
const day = (offset: number) => new Date(Date.parse(`${BUILD_DATE_STAMP}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const event = (id: string, comune = 'Lancy', offset = -30) => ({
  id: `ge-agenda:${id}`, title: `Programme communal ${id}`, startDate: day(offset), endDate: day(offset),
  canton: 'GE', comune, url: `https://www.geneve.ch/agenda/${id}`, sourceKey: 'ge-agenda', sourceName: 'Ville de Genève',
});
const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ event: event(String(index)), canton: 'GE', comune: 'Lancy', slug: `programme-${index}` }));

async function emitFixture(root: string) {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const plugin = eventsSeoPagesPlugin(root);
  const close = plugin.closeBundle;
  if (typeof close !== 'function') throw new Error('Expected the normal event producer hook');
  await close.call({} as never);
}

describe('source-backed municipal event archives', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('keeps the old municipal URL as an explicitly historical, noindex source listing (%s)', (locale) => {
    const options = { locale, entries: entries(2), page: 1, pageCount: 1, distDir: temporary(), municipality: { canton: 'GE', comune: 'Lancy' }, municipalHub: true };
    const page = renderHistoricalEventsArchivePage(options);
    const dom = new JSDOM(page.html);
    const doc = dom.window.document;
    expect(page.urlPath).toBe(pathFor(locale, 'GE', 'Lancy'));
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://frontaliereticino.ch${page.urlPath}`);
    expect(doc.querySelector('[data-events-lifecycle]')?.getAttribute('data-events-lifecycle')).toBe('past');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex,follow');
    expect(page.html).toContain('Programme communal 0');
    expect(page.html).toContain('Programme communal 1');
    expect([...doc.querySelectorAll('time')].map((time) => time.getAttribute('datetime'))).toEqual([day(-30), day(-30)]);
    expect(doc.querySelector('header p')?.textContent?.length).toBeLessThanOrEqual(120);
    expect(doc.querySelector('ol a')?.textContent).toBe('Programme communal 0');
    expect(doc.querySelector('ol a')?.classList.contains('min-h-11')).toBe(true);
    expect(page.html).not.toContain('http-equiv="refresh"');
    dom.window.close();
  });

  it('paginates the complete municipality without borrowing the nationwide archive or dropping tail entries', () => {
    const common = { locale: 'fr' as const, entries: entries(101), pageCount: 2, distDir: temporary(), municipality: { canton: 'GE', comune: 'Lancy' } };
    const first = renderHistoricalEventsArchivePage({ ...common, page: 1 });
    const second = renderHistoricalEventsArchivePage({ ...common, page: 2 });
    expect(first.urlPath).toBe('/fr/evenements/geneve/lancy/archives/');
    expect(second.urlPath).toBe('/fr/evenements/geneve/lancy/archives/page-2/');
    expect(first.html).toContain(`href="${second.urlPath}"`);
    expect(second.html).toContain(`href="${first.urlPath}"`);
    expect(first.html).toContain('href="/fr/evenements/geneve/lancy/programme-0/"');
    expect(first.html).not.toContain('href="/fr/evenements/geneve/lancy/programme-100/"');
    expect(second.html).toContain('href="/fr/evenements/geneve/lancy/programme-100/"');
    expect(second.html).not.toContain('href="/fr/evenements/geneve/lancy/programme-0/"');
  });

  it('emits historical municipal hubs only from admissible past facts and never replaces the active neighbour', async () => {
    const root = temporary();
    fixtures.events = [event('old'), event('past-neighbour', 'Vernier'), event('current-neighbour', 'Vernier', 3),
      { ...event('private', 'Onex'), id: 'eventfrog:private', sourceKey: 'eventfrog', ephemeral: true },
      { ...event('invalid', 'Carouge'), startDate: 'not-a-date', endDate: 'not-a-date' }];
    await emitFixture(root);
    const historical = path.join(root, 'dist/fr/evenements/geneve/lancy/index.html');
    expect(fs.existsSync(historical)).toBe(true);
    const html = fs.readFileSync(historical, 'utf8');
    expect(html).toMatch(/data-events-lifecycle=(?:"past"|past[ >])/);
    expect(html).toContain('Programme communal old');
    const active = fs.readFileSync(path.join(root, 'dist/fr/evenements/geneve/vernier/index.html'), 'utf8');
    expect(active).toMatch(/data-events-lifecycle=(?:"active"|active[ >])/);
    expect(active).toContain('Programme communal current-neighbour');
    expect(active).toContain('href="/fr/evenements/geneve/vernier/archives/"');
    expect(fs.existsSync(path.join(root, 'dist/fr/evenements/geneve/onex/archives/index.html'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'dist/fr/evenements/geneve/carouge/archives/index.html'))).toBe(false);
    expect(isEmittedEventArchivePath('/fr/evenements/geneve/lancy/')).toBe(true);
    expect(isEmittedEventArchivePath('/fr/evenements/geneve/vernier/')).toBe(false);
    expect(isEmittedEventArchivePath('/fr/evenements/geneve/vernier/archives/')).toBe(true);
    expect(isEmittedEventArchivePath('/fr/evenements/geneve/onex/archives/')).toBe(false);
    const sitemap = fs.readFileSync(path.join(root, 'dist/sitemap-eventi.xml'), 'utf8');
    expect(sitemap).not.toContain('https://frontaliereticino.ch/fr/evenements/geneve/lancy/</loc>');
    expect(sitemap).not.toContain('/lancy/archives/');
  });

  it.each(['empty', 'skipped'] as const)('clears source-backed compat proofs on a later %s build', async (kind) => {
    fixtures.events = [event('old')];
    await emitFixture(temporary());
    expect(isEmittedEventArchivePath('/fr/evenements/geneve/lancy/')).toBe(true);
    fixtures.events = [];
    if (kind === 'skipped') vi.stubEnv('SKIP_EVENTS_PAGES', '1');
    await emitFixture(temporary());
    expect(isEmittedEventArchivePath('/fr/evenements/geneve/lancy/')).toBe(false);
  });

  it('keeps output bounded at three times the largest measured bucket and preserves every tail page', () => {
    const count = 1235;
    const render = (size: number, page = 1) => renderHistoricalEventsArchivePage({ locale: 'de', entries: entries(size), page,
      pageCount: Math.ceil(size / 100), distDir: temporary(), municipality: { canton: 'GE', comune: 'Lancy' } });
    const first = render(count);
    const grown = render(count * 3);
    expect(Buffer.byteLength(grown.html)).toBeLessThan(MAX_HTML_BYTES);
    expect(Math.abs(Buffer.byteLength(grown.html) - Buffer.byteLength(first.html))).toBeLessThan(8192);
    const tail = render(count * 3, Math.ceil(count * 3 / 100));
    expect(tail.html).toContain(`programme-${count * 3 - 1}/`);
    expect(tail.html).not.toContain('programme-0/');
  });

  it('keeps identically named towns in different cantons separate', async () => {
    fixtures.events = [event('geneva', 'Same Town'), { ...event('vaud', 'Same Town'), canton: 'VD' }];
    const root = temporary();
    await emitFixture(root);
    for (const [canton, own, other] of [['GE', 'geneva', 'vaud'], ['VD', 'vaud', 'geneva']]) {
      const html = fs.readFileSync(path.join(root, 'dist', pathFor('fr', canton, 'Same Town'), 'index.html'), 'utf8');
      expect(html).toContain(`Programme communal ${own}`);
      expect(html).not.toContain(`Programme communal ${other}`);
    }
  });

  it('recovers all fifteen additional reported municipalities from their exact historical public facts', async () => {
    const recovery = JSON.parse(fs.readFileSync(new URL('../data/events-recovery-archive.json', import.meta.url), 'utf8'));
    const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/gsc-event-municipal-archives.json', import.meta.url), 'utf8'));
    expect(fixture.rows).toHaveLength(15);
    expect(fixture.records).toHaveLength(20);
    const recovered = fixture.records.map((expected: { id: string; facts: object; sourceSnapshot: string; sourceGeneratedAt: string }) => {
      const record = recovery.events.find((event: { id: string }) => event.id === expected.id);
      expect(record, expected.id).toBeDefined();
      expect(record, expected.id).toMatchObject(expected.facts);
      expect(record.recoveryEvidence).toMatchObject({ sourceSnapshot: expected.sourceSnapshot, sourceGeneratedAt: expected.sourceGeneratedAt });
      return record;
    });
    for (const id of fixture.excludedTwins) expect(recovery.events.some((event: { id: string }) => event.id === id), id).toBe(false);
    fixtures.events = recovered;
    const root = temporary();
    await emitFixture(root);
    for (const row of fixture.rows) {
      const html = fs.readFileSync(path.join(root, 'dist', row.path, 'index.html'), 'utf8');
      const dom = new JSDOM(html);
      const doc = dom.window.document;
      expect(doc.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://frontaliereticino.ch${row.path}`);
      expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex,follow');
      const titles = [...doc.querySelectorAll('ol a')].map((link) => link.textContent);
      const expected = allEndedEvents(recovered.filter((event: { id: string }) => row.ids.includes(event.id)), BUILD_DATE_STAMP);
      expect(titles).toEqual(expected.map((event: { title: string; titleByLocale?: Record<string, string> }) => event.titleByLocale?.[row.locale] || event.title));
      expect([...doc.querySelectorAll('time')].map((time) => time.getAttribute('datetime'))).toEqual(expected.map((event: { startDate: string }) => event.startDate));
      for (const link of doc.querySelectorAll('ol a')) expect(fs.existsSync(path.join(root, 'dist', link.getAttribute('href')!, 'index.html'))).toBe(true);
      dom.window.close();
    }
  });
});
