// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assemble, retainPublishedPastEvents } from '../scripts/assemble-events-dataset.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const old = { id: 'guidle:old', sourceKey: 'guidle', title: 'Concerto storico', startDate: day(-10), comune: 'Lugano', canton: 'TI' };

describe('assembled permanent event archive', () => {
  it('retains ended public events absent from all source slices', () => {
    expect(retainPublishedPastEvents([], [old])).toEqual([expect.objectContaining({ id: old.id })]);
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
