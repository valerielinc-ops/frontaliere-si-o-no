import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractTioDetailMetadata,
  mergeTioEventsById,
  parseTioEventIds,
  selectTioEventsByIds,
} from '../scripts/crawl-tio-agenda.mjs';
import { mergeEventsIntoSlice } from '../scripts/lib/crawl-checkpoint.mjs';

describe('Tio targeted event refresh', () => {
  it('parses and deduplicates numeric event IDs', () => {
    expect(parseTioEventIds(['--ids', '63833, 63834,63833'])).toEqual(['63833', '63834']);
    expect(parseTioEventIds(['--days', '21'])).toEqual([]);
  });

  it('rejects malformed IDs and conflicting day-window arguments', () => {
    expect(() => parseTioEventIds(['--ids', ''])).toThrow(/numeric Tio event IDs/);
    expect(() => parseTioEventIds(['--ids', '63833,not-a-number'])).toThrow(/numeric Tio event IDs/);
    expect(() => parseTioEventIds(['--ids', '63833', '--days', '21'])).toThrow(/cannot be combined/);
  });

  it('selects only existing events and fails for IDs absent from the source slice', () => {
    const sourceEvents = [
      { id: 'tio-agenda:63833', title: 'JazzAscona meets classicAscona' },
      { id: 'tio-agenda:63834', title: 'Another event' },
    ];
    expect(selectTioEventsByIds(sourceEvents, ['63833'])).toEqual([sourceEvents[0]]);
    expect(selectTioEventsByIds(sourceEvents, ['63834', '63833'])).toEqual(sourceEvents);
    expect(() => selectTioEventsByIds(sourceEvents, ['99999'])).toThrow(/not found in the existing source slice/);
  });

  it('updates selected records in place and preserves other source-slice rows', () => {
    const sourceEvents = [
      { id: 'tio-agenda:63833', title: 'First event', startDate: '2026-11-03', comune: 'Bellinzona', canton: 'TI' },
      { id: 'tio-agenda:63834', title: 'Unrelated event', startDate: '2026-11-04', comune: 'Lugano', canton: 'TI' },
    ];
    const update = mergeTioEventsById(sourceEvents, [
      { ...sourceEvents[0], title: 'Updated first event', crawledAt: '2026-11-02T12:00:00.000Z' },
    ]);

    expect(update.events.map((event) => event.id)).toEqual(sourceEvents.map((event) => event.id));
    expect(update.events[0].title).toBe('Updated first event');
    expect(update.events[1]).toEqual(sourceEvents[1]);

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'tio-targeted-refresh-'));
    const slicePath = path.join(tempDir, 'tio-agenda.json');
    try {
      writeFileSync(slicePath, JSON.stringify({
        schemaVersion: 1,
        sourceKey: 'tio-agenda',
        sourceName: 'Tio.ch Agenda',
        canton: 'TI',
        assembledAt: '2026-11-01T12:00:00.000Z',
        events: sourceEvents,
      }));
      mergeEventsIntoSlice({
        slicePath,
        sourceKey: 'tio-agenda',
        sourceName: 'Tio.ch Agenda',
        canton: 'TI',
        freshEvents: update.changedEvents,
        goneIds: [],
        crawledAt: '2026-11-02T12:00:00.000Z',
        detailAttemptCount: 1,
      });

      const written = JSON.parse(readFileSync(slicePath, 'utf8'));
      expect(written.events.map((event) => event.id)).toEqual(sourceEvents.map((event) => event.id));
      expect(written.events[0].title).toBe('Updated first event');
      expect(written.events[1]).toEqual(sourceEvents[1]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps crawledAt for unchanged targets and refreshes it when source data changes', () => {
    const previous = {
      id: 'tio-agenda:63833',
      title: 'JazzAscona meets classicAscona',
      performer: { name: 'Elina Duni' },
      crawledAt: '2026-11-01T12:00:00.000Z',
    };
    const unchanged = mergeTioEventsById([previous], [{
      ...previous,
      crawledAt: '2026-11-02T12:00:00.000Z',
    }]);
    expect(unchanged.events[0].crawledAt).toBe(previous.crawledAt);
    expect(unchanged.changedEvents).toEqual([]);

    const changed = mergeTioEventsById([previous], [{
      ...previous,
      performer: [{ name: 'Elina Duni' }, { name: 'Rob Luft' }],
      crawledAt: '2026-11-02T12:00:00.000Z',
    }]);
    expect(changed.changedEvents).toHaveLength(1);
    expect(changed.changedEvents[0].crawledAt).toBe('2026-11-02T12:00:00.000Z');
  });

  it('extracts source-listed JazzAscona performers from a detail description', () => {
    const html = `
      <main>
        <h1>JazzAscona meets classicAscona</h1>
        <p>Una serata di incontri oltre i confini di genere musicale promette JazzAscona meets classicAscona. Il trio con la cantante albanese-svizzera Elina Duni, il chitarrista britannico Rob Luft e il flicornista svizzero Matthieu Michel è noto per il suo dialogo fluido tra jazz, folk e chanson. Incontra il Vision String Quartet di Berlino, che spesso suona a memoria e in piedi, creando una presenza scenica intensa, quasi da pop band.</p>
      </main>
    `;
    expect(extractTioDetailMetadata(html)).toEqual({
      description: 'Una serata di incontri oltre i confini di genere musicale promette JazzAscona meets classicAscona. Il trio con la cantante albanese-svizzera Elina Duni, il chitarrista britannico Rob Luft e il flicornista svizzero Matthieu Michel è noto per il suo dialogo fluido tra jazz, folk e chanson. Incontra il Vision String Quartet di Berlino, che spesso suona a memoria e in piedi, creando una presenza scenica intensa, quasi da pop band.',
      performer: [
        { name: 'Elina Duni' },
        { name: 'Rob Luft' },
        { name: 'Matthieu Michel' },
        { '@type': 'PerformingGroup', name: 'Vision String Quartet' },
      ],
    });
  });
});
