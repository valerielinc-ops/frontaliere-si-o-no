// @vitest-environment node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { reset } from '../build-plugins/sharedWriteRegistry';
import { replaceEmittedEventArchivePaths } from '../build-plugins/shared/eventArchiveCompat';
import { _resetForTests as resetTrafficEvidence } from '../build-plugins/shared/trafficEvidenceFilter';

const fixtures = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));

vi.mock('../build-plugins/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../build-plugins/constants')>();
  return { ...actual, countHtmlBodyWords: () => 49 };
});
vi.mock('../scripts/lib/events-utils.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/events-utils.mjs')>();
  return { ...actual, loadEventsDataset: (file?: string) => ({ events: file ? [] : fixtures.events, totalEvents: file ? 0 : fixtures.events.length }) };
});
vi.mock('../build-plugins/shared/buildSignals', () => ({ staticPagesFlushed: Promise.resolve() }));

let eventsSeoPagesPlugin: typeof import('../build-plugins/eventsSeoPagesPlugin').eventsSeoPagesPlugin;
let renderEventDetailPage: typeof import('../build-plugins/eventsSeoPagesPlugin').renderEventDetailPage;

beforeAll(async () => {
  const module = await import('../build-plugins/eventsSeoPagesPlugin');
  eventsSeoPagesPlugin = module.eventsSeoPagesPlugin;
  renderEventDetailPage = module.renderEventDetailPage;
});

const roots: string[] = [];
const temporary = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'events-past-thin-'));
  roots.push(root);
  return root;
};

const THIN_PAST_EVENT = {
  id: 'fixture-agenda:thin-past',
  title: 'Evento storico breve',
  startDate: '2026-01-01',
  endDate: '2026-01-01',
  canton: 'GE',
  comune: 'Lancy',
  url: 'https://agenda.example.ch/thin-past',
  sourceKey: 'fixture-agenda',
  sourceName: 'Agenda di prova',
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  fixtures.events = [];
  reset();
  replaceEmittedEventArchivePaths([]);
  resetTrafficEvidence();
});

function findEventDetail(distDir: string): { urlPath: string; html: string } {
  let result: { urlPath: string; html: string } | undefined;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'index.html') {
        const html = fs.readFileSync(full, 'utf8');
        if (!/data-events-page=["']?event_detail\b/.test(html)) continue;
        result = {
          urlPath: `/${path.relative(distDir, path.dirname(full)).split(path.sep).join('/')}/`,
          html,
        };
      }
    }
  };
  walk(distDir);
  if (!result) throw new Error('thin historical event detail was not emitted');
  return result;
}

describe('historical event content floor', () => {
  it('keeps a 49-word past detail out of the index and sitemap', async () => {
    const direct = renderEventDetailPage({
      locale: 'it',
      event: THIN_PAST_EVENT as never,
      comune: 'Lancy',
      eventSlug: 'evento-storico-breve',
      sameComuneEvents: [],
      dateStamp: '2026-10-25',
      distDir: '',
      detailHref: () => null,
      isPast: true,
    });
    expect(direct.wordCount).toBe(49);
    expect(direct.html).toMatch(/noindex,follow/);

    const root = temporary();
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fixtures.events = [THIN_PAST_EVENT];
    const close = eventsSeoPagesPlugin(root).closeBundle;
    if (typeof close !== 'function') throw new Error('Expected the normal event producer hook');
    await close.call({} as never);

    const detail = findEventDetail(path.join(root, 'dist'));
    const sitemap = fs.readFileSync(path.join(root, 'dist', 'sitemap-eventi.xml'), 'utf8');
    expect(detail.html).toMatch(/noindex,follow/);
    expect(sitemap).not.toContain(`<loc>https://frontaliereticino.ch${detail.urlPath}</loc>`);
  });
});
