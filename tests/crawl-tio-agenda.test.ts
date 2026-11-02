import { describe, expect, it } from 'vitest';
import {
  extractTioDetailMetadata,
  parseTioEventIds,
  selectTioEventsByIds,
} from '../scripts/crawl-tio-agenda.mjs';

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
    expect(() => selectTioEventsByIds(sourceEvents, ['99999'])).toThrow(/not found in the existing source slice/);
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
