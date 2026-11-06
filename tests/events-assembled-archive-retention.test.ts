// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assemble, retainPublishedPastEvents } from '../scripts/assemble-events-dataset.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventDateIssues } from '../scripts/lib/events-date-quality.mjs';
import { isPrivateEventRecord } from '../scripts/lib/private-event-sources.mjs';
import { eventRouteForHistory } from '../scripts/lib/events-retention.mjs';
import { UNRESOLVED_CANTON_KEY } from '../scripts/lib/events-utils.mjs';

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const old = { id: 'guidle:old', sourceKey: 'guidle', title: 'Concerto storico', startDate: day(-10), comune: 'Lugano', canton: 'TI' };

describe('assembled permanent event archive', () => {
  it('keeps the recovery seed attributable, unique and limited to public facts', () => {
    const seed = JSON.parse(fs.readFileSync(new URL('../data/events-recovery-archive.json', import.meta.url), 'utf8'));
    expect(seed.events.length).toBeGreaterThan(0);
    expect(new Set(seed.events.map((event: { id: string }) => event.id)).size).toBe(seed.events.length);
    for (const snapshot of seed.sourceSnapshots) expect(snapshot.commit).toMatch(/^[a-f0-9]{40}$/);
    for (const event of seed.events) {
      expect(eventDateIssues(event)).toEqual([]);
      expect(isPrivateEventRecord(event)).toBe(false);
      expect(event.url).toMatch(/^https:\/\//);
      expect(Object.keys(event).some((key) => /description|image/i.test(key))).toBe(false);
    }
  });

  it('retains ended public events absent from all source slices', () => {
    expect(retainPublishedPastEvents([], [old])).toEqual([expect.objectContaining({ id: old.id })]);
  });

  it('preserves observed TI fallback aliases without inventing the actual event canton', () => {
    const seed = JSON.parse(fs.readFileSync(new URL('../data/events-recovery-archive.json', import.meta.url), 'utf8'));
    const unknownIds = ['myswitzerland:fc825d8005a3495eb23e1a7d5ff5b336', 'myswitzerland:b01b0e138bef40e4aea8723b5223cfae', 'myswitzerland:c7c2b5957cf44c61b43bb88f43681982', 'myswitzerland:0b47c321f75c4103af16a10c4b180588'];
    for (const id of unknownIds) {
      const event = seed.events.find((row: { id: string }) => row.id === id);
      expect(event, id).toBeDefined();
      expect(event.canton).toBe('');
      expect(eventRouteForHistory(event).canton).toBe(UNRESOLVED_CANTON_KEY);
      expect(event.previousRoutes).toContainEqual(expect.objectContaining({ canton: 'TI', comune: '__other-events__' }));
    }
    const kino = seed.events.find((row: { id: string }) => row.id === 'myswitzerland:69d1950737804d91b726e41270532111');
    const afterEnd = new Date(Date.parse(`${kino.endDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    for (const retained of [retainPublishedPastEvents([kino], [kino], kino.startDate)[0], retainPublishedPastEvents([], [kino], afterEnd)[0]]) {
      expect(retained.canton).toBe('GR');
      expect(retained.previousRoutes).toContainEqual(expect.objectContaining({ canton: 'TI', comune: '__other-events__' }));
    }
  });

  it('keeps one explicit route after repeated recovery-only retention passes', () => {
    const first = retainPublishedPastEvents([], [old]);
    const second = retainPublishedPastEvents([], first);
    expect(first[0].previousRoutes).toHaveLength(1);
    expect(second[0].previousRoutes).toEqual(first[0].previousRoutes);
  });

  it('adds the verified MySwitzerland route to the existing Guidle owner without reviving a missing upcoming record', () => {
    const seed = JSON.parse(fs.readFileSync(new URL('../data/events-recovery-archive.json', import.meta.url), 'utf8'));
    const prior = seed.events.find((event: { id: string }) => event.id === 'guidle:An77Y4G');
    expect(prior).toBeDefined();
    expect(seed.events.some((event: { id: string }) => event.id === prior.recoveryEvidence.previousId)).toBe(false);
    const route = {
      canton: 'SO', comune: 'Lüsslingen-Nennigkofen',
      slug: 'kulturkommision-lusslingen-nennigkofen-prasentiert-das-2026-07-10',
    };
    expect(prior.previousRoutes).toContainEqual(route);
    const fresh = { ...prior, startDate: day(1), endDate: day(2), startTime: '20:15', previousRoutes: [] };
    const [merged] = retainPublishedPastEvents([fresh], [prior], day(0));
    expect(merged).toMatchObject({ id: fresh.id, startDate: day(1), endDate: day(2), startTime: '20:15' });
    expect(merged.previousRoutes).toContainEqual(route);
    expect(retainPublishedPastEvents([], [prior], prior.startDate)).toEqual([]);
    const [archived] = retainPublishedPastEvents([], [merged], day(3));
    expect(archived.previousRoutes).toContainEqual(route);
    const [again] = retainPublishedPastEvents([], [archived], day(3));
    expect(again.previousRoutes.filter((item: typeof route) => item.slug === route.slug)).toHaveLength(1);
  });

  it('resolves duplicate historical IDs before assigning collision slugs', () => {
    const last = { ...old, title: 'Ultima osservazione' };
    const [result] = retainPublishedPastEvents([], [old, last]);
    expect(result.title).toBe(last.title);
    expect(result.previousRoutes).toHaveLength(1);
    expect(result.previousRoutes[0].slug).toContain('ultima-osservazione-');
  });

  it('does not revive missing upcoming, private or invalid records', () => {
    expect(retainPublishedPastEvents([], [
      { ...old, startDate: day(1) },
      { ...old, id: 'eventfrog:1' },
      { ...old, ephemeral: true },
      { ...old, startDate: '2926-01-01' },
      { ...old, startDate: 'not-a-date' },
    ])).toEqual([]);
  });

  it('prefers refreshed facts and retains the old route for the same id', () => {
    const fresh = { ...old, title: 'Concerto aggiornato', startDate: day(2) };
    const [result] = retainPublishedPastEvents([fresh], [old]);
    expect(result.title).toBe(fresh.title);
    expect(result.startDate).toBe(fresh.startDate);
    expect(result.previousRoutes).toContainEqual(expect.objectContaining({ slug: expect.stringContaining('concerto-storico-') }));
  });

  it('strips acquired descriptions and unauthorized images from retained facts', () => {
    const [result] = retainPublishedPastEvents([], [{ ...old, description: 'Source prose', imageUrl: '/images/events/guidle-old.jpg' }]);
    expect(result).not.toHaveProperty('description');
    expect(result).not.toHaveProperty('imageUrl');
  });

  it('assembles recovered records into both public datasets and keeps them on the next run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-archive-'));
    try {
      const sliceDir = path.join(root, 'data/events/by-source');
      const datasetPath = path.join(root, 'data/events.json');
      fs.mkdirSync(sliceDir, { recursive: true });
      fs.writeFileSync(path.join(root, 'data/events-recovery-archive.json'), JSON.stringify({ events: [old] }));
      const first = assemble({ sliceDir, datasetPath });
      expect(first.events.map((event: { id: string }) => event.id)).toContain(old.id);
      fs.unlinkSync(path.join(root, 'data/events-recovery-archive.json'));
      const second = assemble({ sliceDir, datasetPath });
      expect(second.events.map((event: { id: string }) => event.id)).toContain(old.id);
      expect(JSON.parse(fs.readFileSync(path.join(root, 'public/data/events.json'), 'utf8')).events).toEqual(second.events);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
