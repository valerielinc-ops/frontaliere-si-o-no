import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorialSourceBrief } from '../scripts/social-copy/editorial-source-brief.mjs';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'editorial-source-brief-'));
  directories.push(directory);
  return directory;
}

describe('sanitized editorial source brief', () => {
  it('summarizes recent public topic metadata without copying article claims or ranking fields', () => {
    const directory = fixtureDirectory();
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'recent.json'), JSON.stringify({
      slug: 'nuove-regole-trasporto-frontalieri',
      publishedAt: '2026-11-02T10:00:00.000Z',
      cluster: 'mobilita',
      title: 'Claim editoriale che non va incluso',
      _score_breakdown: { matchedQuery: 'private ranking query', rawScore: 123 },
    }));
    writeFileSync(path.join(directory, 'older.json'), JSON.stringify({
      slug: 'nuovo-calcolo-pensione', publishedAt: '2026-10-15T10:00:00.000Z', cluster: 'pensioni',
    }));
    writeFileSync(path.join(directory, 'future.json'), JSON.stringify({
      slug: 'contenuto-futuro', publishedAt: '2026-11-04T10:00:00.000Z', cluster: 'lavoro',
    }));
    writeFileSync(path.join(directory, 'stale.json'), JSON.stringify({
      slug: 'contenuto-datato', publishedAt: '2026-09-01T10:00:00.000Z', cluster: 'lavoro',
    }));
    writeFileSync(path.join(directory, 'broken.json'), '{');
    writeFileSync(path.join(directory, 'unsafe.json'), JSON.stringify({
      slug: 'Titolo con dati personali@example.com', publishedAt: '2026-11-02T10:00:00.000Z', cluster: 'lavoro',
    }));

    const brief = buildEditorialSourceBrief({
      articleDirectory: directory,
      eventDirectory: fixtureDirectory(),
      asOf: '2026-11-03T12:00:00.000Z',
    });

    expect(brief).toMatchObject({
      available: true,
      sourceCount: 2,
      unreadableSourceCount: 1,
      clusters: { mobilita: 1, pensioni: 1 },
      recentTopics: [
        { publishedOn: '2026-11-02', topic: 'nuove-regole-trasporto-frontalieri', cluster: 'mobilita' },
        { publishedOn: '2026-10-15', topic: 'nuovo-calcolo-pensione', cluster: 'pensioni' },
      ],
      historicalWindowDays: 365,
      historicalTopicCount: 1,
      historicalClusters: { lavoro: 1 },
      historicalTopics: [
        { publishedOn: '2026-09-01', topic: 'contenuto-datato', cluster: 'lavoro', ageDays: 63 },
      ],
    });
    expect(JSON.stringify(brief)).not.toContain('Claim editoriale');
    expect(JSON.stringify(brief)).not.toContain('private ranking query');
    expect(JSON.stringify(brief)).not.toContain('personali@example.com');
    expect(JSON.stringify(brief)).not.toContain('contenuto-futuro');
  });

  it('reports missing recent sources as unavailable instead of inventing zero performance', () => {
    const brief = buildEditorialSourceBrief({
      articleDirectory: fixtureDirectory(),
      eventDirectory: fixtureDirectory(),
      asOf: '2026-11-03T12:00:00.000Z',
    });
    expect(brief).toMatchObject({
      available: false,
      sourceCount: 0,
      clusters: {},
      recentTopics: [],
      historicalTopicCount: 0,
      historicalTopics: [],
    });
    expect(brief.interpretation).toContain('no article claims');
  });

  it('adds only fresh, upcoming Ticino event categories and never sends event titles', () => {
    const articles = fixtureDirectory();
    const events = path.join(fixtureDirectory(), 'by-source');
    mkdirSync(events, { recursive: true });
    const record = {
      id: 'public-event-1',
      canton: 'TI',
      startDate: '2026-11-08',
      category: 'Musica',
      title: 'Titolo pubblico con nome da non inoltrare al modello',
      url: 'https://events.example.ch/event/one?source=private',
    };
    writeFileSync(path.join(events, 'fresh-one.json'), JSON.stringify({
      assembledAt: '2026-11-02T12:00:00.000Z',
      events: [
        record,
        { ...record, id: 'duplicate-from-other-source' },
        { ...record, id: 'other-canton', canton: 'ZH', url: 'https://events.example.ch/event/zurich' },
        { ...record, id: 'past-event', startDate: '2026-11-02', url: 'https://events.example.ch/event/past' },
        { ...record, id: 'too-far', startDate: '2026-12-20', url: 'https://events.example.ch/event/far' },
        { ...record, id: 'invalid-calendar-date', startDate: '2026-11-31', url: 'https://events.example.ch/event/invalid' },
      ],
    }));
    writeFileSync(path.join(events, 'stale.json'), JSON.stringify({
      assembledAt: '2026-10-01T12:00:00.000Z',
      events: [{ ...record, id: 'stale-event', url: 'https://events.example.ch/event/stale' }],
    }));

    const brief = buildEditorialSourceBrief({
      articleDirectory: articles,
      eventDirectory: events,
      asOf: '2026-11-03T12:00:00.000Z',
    });

    expect(brief.available).toBe(false);
    expect(brief.upcomingTicinoEvents).toMatchObject({
      available: true,
      canton: 'TI',
      windowDays: 30,
      eventCount: 1,
      sourceCount: 1,
      categories: [{ name: 'Musica', count: 1 }],
      latestSourceAt: '2026-11-02T12:00:00.000Z',
    });
    expect(JSON.stringify(brief)).not.toContain('Titolo pubblico');
    expect(JSON.stringify(brief)).not.toContain('private');
    expect(JSON.stringify(brief)).not.toContain('event/one');
  });
});
