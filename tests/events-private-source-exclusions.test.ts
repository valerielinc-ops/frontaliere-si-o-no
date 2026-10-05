// @vitest-environment node
/**
 * Eventfrog AGB v1.28 §17(3) (no hand-over to third parties) and §17(6)
 * (content only to announce the event): a private-source record must never
 * reach a public export or a reuse that is not the event's own page.
 *
 * Both repositories are public and the corpus republishes
 * public/data/events.json as an open JSON API, so the public dataset is the
 * boundary. Each reader of the events dataset for another use (Facebook,
 * digest article) applies the same predicate, and the private snapshot lives
 * only in git-ignored or Admin-SDK-only places.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  assertNoPrivateEvents,
  isPrivateEventRecord,
  PRIVATE_EVENT_SOURCE_KEYS,
  withoutPrivateEvents,
} from '../scripts/lib/private-event-sources.mjs';
import {
  EVENTFROG_SNAPSHOT_CACHE_PATH,
  EVENTFROG_SNAPSHOT_OBJECT,
  PRIVATE_EVENTS_STORAGE_PREFIX,
  uploadSnapshot,
} from '../scripts/lib/private-event-snapshots.mjs';
import { assemble } from '../scripts/assemble-events-dataset.mjs';
import { run as runFbPoster } from '../scripts/schedule-fb-events-daily.mjs';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const TIO = {
  id: 'tio-agenda:1',
  title: 'Concerto sinfonico',
  startDate: inDays(3),
  comune: 'Lugano',
  canton: 'TI',
  url: 'https://www.tio.ch/agenda/1',
  sourceKey: 'tio-agenda',
  sourceName: 'Tio.ch Agenda',
};
const FROG = {
  id: 'eventfrog:42',
  title: 'Jazz al lago',
  startDate: inDays(2),
  comune: 'Lugano',
  canton: 'TI',
  url: 'https://eventfrog.ch/de/p/event-42',
  sourceKey: 'eventfrog',
  sourceName: 'Eventfrog',
  ephemeral: true,
};

describe('isPrivateEventRecord', () => {
  it('recognises a private record by source key, id prefix or ephemeral marker', () => {
    expect(PRIVATE_EVENT_SOURCE_KEYS).toContain('eventfrog');
    expect(isPrivateEventRecord(FROG)).toBe(true);
    expect(isPrivateEventRecord({ id: 'eventfrog:1' })).toBe(true);
    expect(isPrivateEventRecord({ id: 'x', sourceKey: 'Eventfrog' })).toBe(true);
    expect(isPrivateEventRecord({ id: 'tio-agenda:1', ephemeral: true })).toBe(true);
    expect(isPrivateEventRecord(TIO)).toBe(false);
    expect(isPrivateEventRecord(null)).toBe(false);
  });

  it('assertNoPrivateEvents refuses without echoing the record', () => {
    expect(() => assertNoPrivateEvents([TIO], 'x')).not.toThrow();
    let message = '';
    try {
      assertNoPrivateEvents([TIO, FROG], 'public events dataset boundary');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/1 private-source event record/);
    expect(message).not.toContain('Jazz');
    expect(message).not.toContain('eventfrog:42');
    expect(withoutPrivateEvents([TIO, FROG])).toEqual([TIO]);
  });
});

describe('the public events dataset (data/events.json + public/data/events.json, the corpus API source)', () => {
  it('assemble drops a private record found in a slice and from the carried-over prior dataset', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-private-'));
    const sliceDir = path.join(root, 'data', 'events', 'by-source');
    fs.mkdirSync(sliceDir, { recursive: true });
    const assembledAt = new Date().toISOString();
    fs.writeFileSync(path.join(sliceDir, 'tio-agenda.json'), JSON.stringify({ schemaVersion: 1, sourceKey: 'tio-agenda', assembledAt, events: [TIO] }));
    fs.writeFileSync(path.join(sliceDir, 'eventfrog.json'), JSON.stringify({ schemaVersion: 1, sourceKey: 'eventfrog', assembledAt, events: [FROG] }));
    const datasetPath = path.join(root, 'data', 'events.json');
    const result = assemble({ sliceDir, datasetPath });
    expect(result.privateRecords).toBe(1);
    for (const file of [datasetPath, result.publicPath]) {
      expect(file.startsWith(root)).toBe(true);
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(doc.events.map((e: { id: string }) => e.id)).toEqual(['tio-agenda:1']);
      expect(fs.readFileSync(file, 'utf8')).not.toContain('eventfrog');
    }
  });
});

describe('reuse outside the announcement page (§17(6))', () => {
  it('the Facebook poster never selects a private record, even if one reached data/events.json', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-private-'));
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'events.json'), JSON.stringify({ schemaVersion: 1, events: [FROG, TIO] }));
    fs.writeFileSync(path.join(root, 'data', 'fb-place-ids.json'), JSON.stringify({ schemaVersion: 1, places: {} }));
    const res = await runFbPoster({
      env: { DRY_RUN: '1', FB_EVENT_VOLUME: '5', FB_EVENTS_DIGEST_DOW: '-1' },
      repoRoot: root,
      todayIso: inDays(0),
      fetchImpl: (() => Promise.reject(new Error('no network in dry-run'))) as any,
      log: () => {},
      warn: () => {},
    });
    const ids = (res.payloads as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toEqual(['tio-agenda:1']);
  });

  // The weekend digest ARTICLE is produced by the corpus
  // (refresh-events-digest.yml there; the site copy of the generator is dormant
  // since the cutover). It reads public/data/events.json — proven clean by the
  // assemble case above — and the corpus drops private records again at its
  // only entry point (generator/scripts/lib/private-event-records.mjs, with its
  // own test).

  it('the events page builder keeps private records out of digests and the archive', () => {
    const src = read('build-plugins/eventsSeoPagesPlugin.ts');
    expect(src).toMatch(/d\.filter\(digestEligibleEvents\(events\)/);
    expect(src).toMatch(/partitionEventsForBuild\(dataset\.events/);
  });
});

describe('where the snapshot may live', () => {
  it('the build-time copy is git-ignored and outside data/ and public/', () => {
    const rel = path.relative(ROOT, EVENTFROG_SNAPSHOT_CACHE_PATH);
    expect(rel.startsWith('data/') || rel.startsWith('public/')).toBe(false);
    const ignored = execFileSync('git', ['check-ignore', '--no-index', '-v', rel], { cwd: ROOT, encoding: 'utf8' });
    expect(ignored).toContain('.gitignore');
  });

  it('storage.rules deny every client on the private prefix', () => {
    const rules = read('storage.rules');
    const prefix = PRIVATE_EVENTS_STORAGE_PREFIX.replace(/\/$/, '');
    expect(EVENTFROG_SNAPSHOT_OBJECT.startsWith(PRIVATE_EVENTS_STORAGE_PREFIX)).toBe(true);
    const block = new RegExp(`match /${prefix}/\\{allPaths=\\*\\*\\} \\{\\s*allow read, write: if false;\\s*\\}`);
    expect(rules).toMatch(block);
  });

  it('uploadSnapshot refuses an object outside the private prefix', async () => {
    const bucket = { file: () => ({ save: async () => undefined }) };
    await expect(uploadSnapshot(bucket, { events: [] }, 'public/eventfrog.json')).rejects.toThrow(/outside private-event-snapshots/);
  });

  it('the sync workflow commits nothing and uploads no artifact; the deploy fetches before building', () => {
    const sync = YAML.parse(read('.github/workflows/sync-eventfrog.yml'));
    const steps = sync.jobs.sync.steps as Array<{ uses?: string; run?: string }>;
    const runText = steps.map((s) => s.run || '').join('\n');
    expect(steps.some((s) => /upload-artifact|cache@/.test(String(s.uses || '')))).toBe(false);
    expect(runText).not.toMatch(/git (commit|push)|open-data-refresh-pr|gh pr create/);
    expect(sync.permissions.contents).toBe('read');
    expect(runText).toContain('node scripts/sync-eventfrog-snapshot.mjs');

    const deploy = YAML.parse(read('.github/workflows/deploy.yml'));
    const buildSteps = deploy.jobs['build-locale'].steps as Array<{ name?: string; run?: string }>;
    const fetchAt = buildSteps.findIndex((s) => (s.run || '').includes('fetch-private-event-snapshots.mjs'));
    const buildAt = buildSteps.findIndex((s) => (s.run || '').includes('npm run build:ci'));
    expect(fetchAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeLessThan(buildAt);
    const rcAt = buildSteps.findIndex((s) => (s.run || '').includes('node scripts/load-rc-env.mjs'));
    expect(rcAt).toBeLessThan(fetchAt);
  });

  it('the Remote Config bridge maps the switch and the key', async () => {
    const { RC_TO_ENV } = await import('../scripts/load-rc-env.mjs');
    expect(RC_TO_ENV.EVENTFROG_ENABLED).toEqual(['EVENTFROG_ENABLED']);
    expect(RC_TO_ENV.EVENTFROG_PUBLIC_API_KEY).toEqual(['EVENTFROG_PUBLIC_API_KEY']);
    // Never a VITE_ alias: the key must not reach the client bundle.
    expect(JSON.stringify(RC_TO_ENV.EVENTFROG_PUBLIC_API_KEY)).not.toContain('VITE_');
  });
});
