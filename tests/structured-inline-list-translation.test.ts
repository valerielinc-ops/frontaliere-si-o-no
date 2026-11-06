import { describe, expect, it } from 'vitest';
import {
  countListItems,
  hasStructureParity,
  isAcceptableTranslation,
  preserveStructuredTranslation,
} from '../scripts/lib/translation-quality.mjs';

// Phase 2e, run 38686616395 (2026-10-15): after the Codex quota ran out, all
// 357 refusals were `lost-list-items`. The untranslated descriptions carry
// inline entries on one line («Tätigkeiten - A - B - C»); translated as one
// line, providers turn the « - » separators into commas and the gate counts
// fewer entries than the source.

// A provider that lowercases, drops the closing mark and flattens « - ».
const flatteningProvider = async (text: string) => text
  .toLowerCase()
  .replace(/[.:;!?]$/u, '')
  .replace(/\s+-\s+/g, ', ');

// Shape of the Fachkraft slice: a bullet line, then the inline run.
const inlineSource = [
  '• Aufgaben im Service für unseren Auftraggeber',
  'Tätigkeiten - Störungsanalyse und Reparatur an Maschinen - Wartungen oder Umbauten von Anlagen - Individuelle Trainings für Kunden',
  'Wir bieten ein motiviertes Team und moderne Arbeitsplätze in der Region.',
].join('\n');

describe('preserveStructuredTranslation and inline list entries', () => {
  it('premise: the source carries inline entries the gate counts', () => {
    expect(countListItems(inlineSource)).toBe(4);
  });

  it('keeps every inline entry the gate counts, with a provider that flattens them', async () => {
    const translated = await preserveStructuredTranslation(inlineSource, flatteningProvider);
    expect(countListItems(translated)).toBe(countListItems(inlineSource));
    expect(hasStructureParity(inlineSource, translated)).toBe(true);
    expect(isAcceptableTranslation(inlineSource, translated)).toBe(true);
  });

  it('translates each entry separately, the separators stay the source ones', async () => {
    const seen: string[] = [];
    const recorder = async (text: string) => { seen.push(text); return `[${text}]`; };
    const translated = await preserveStructuredTranslation(inlineSource, recorder);
    expect(seen).toContain('Störungsanalyse und Reparatur an Maschinen');
    expect(seen).toContain('Individuelle Trainings für Kunden');
    expect(translated.split('\n')[1]).toBe(
      '[Tätigkeiten] - [Störungsanalyse und Reparatur an Maschinen] - [Wartungen oder Umbauten von Anlagen] - [Individuelle Trainings für Kunden]',
    );
  });

  it('keeps a hyphen that is not a list entry inside its sentence', async () => {
    const prose = 'Bouchère - Boucher / Charcutière - Charcutier (f/m/d) für unsere Filiale in Lugano mit Erfahrung.';
    const seen: string[] = [];
    await preserveStructuredTranslation(prose, async (text) => { seen.push(text); return text; });
    expect(countListItems(prose)).toBe(0);
    expect(seen).toEqual([prose]);
  });

  it('an HTML line elsewhere in the text does not turn the splitting off for the other lines', async () => {
    // Review of PR 13388: a mixed description lost its inline entries.
    const mixed = ['- Tasks - Repair - Training', '<p>Notes</p>'].join('\n');
    const dictionary: Record<string, string> = { Tasks: 'Aufgaben', Repair: 'Reparatur', Training: 'Schulung' };
    const provider = async (text: string) => dictionary[text] ?? text.replace(/\s+-\s+/g, ', ');
    const translated = await preserveStructuredTranslation(mixed, provider);
    expect(translated.split('\n')).toEqual(['- Aufgaben - Reparatur - Schulung', '<p>Notes</p>']);
    expect(hasStructureParity(mixed, translated)).toBe(true);
  });

  it('does not reshape a segment that opens or closes with a URL', async () => {
    const source = '• Kontakt im Team\nInfos - Bewerbung online - Details: - Mehr unter www.example.ch';
    const provider = async (text: string) => (text.startsWith('Mehr') ? 'www.example.ch/it' : text.toLowerCase());
    const translated = await preserveStructuredTranslation(source, provider);
    expect(translated).toContain('www.example.ch/it');
    expect(translated).not.toContain('Www.');
  });

  it('keeps an uncounted marker an entry depends on («des 24. & 31. Dezembers»)', async () => {
    // Gesundheitsnetz Küsnacht, run 39005358922: « 31. » counts as an entry
    // only next to « 24. »; a provider writing «del 24» dropped the entry and
    // the gate refused the description (52 refusals, one entry each).
    const source = [
      '• ganztägiger Feiertag «Sechseläuten & Chilbi-Montag»',
      '• 1/2 Arbeitstag Nachmittag des 24. & 31. Dezembers',
      '• Weiterbildung im Team und im ganzen Betrieb',
    ].join('\n');
    const provider = async (text: string) => text
      .replace('Arbeitstag Nachmittag des 24.', 'giorno lavorativo pomeriggio del 24')
      .replace('Dezembers', 'Dicembre');
    const before = countListItems(source);
    const translated = await preserveStructuredTranslation(source, provider);
    expect(countListItems(translated)).toBe(before);
    expect(translated).toContain(' 24. ');
    expect(hasStructureParity(source, translated)).toBe(true);
  });

  it('keeps a range or a URL label next to a counted numeric entry (review of PR 13654)', async () => {
    const source = [
      '• Pensum 80% - 100% nach Vereinbarung',
      '• Start am 1. & 15. März oder später, Infos: www.example.ch',
    ].join('\n');
    // A provider that rewrites the words and lowercases them, as Italian does.
    const provider = async (text: string) => text
      .replace('Pensum', 'grado')
      .replace('nach Vereinbarung', 'da concordare')
      .replace('Start am', 'inizio il')
      .replace('März oder später', 'marzo o più tardi')
      .toLowerCase();
    const translated = await preserveStructuredTranslation(source, provider);
    expect(countListItems(translated)).toBe(countListItems(source));
    expect(translated).toContain('www.example.ch');
    expect(translated).toContain(' 1. & 15. ');
  });

  it('aligns markers after a tab-indented bullet prefix', async () => {
    const source = ['\t•  Aufgaben im Team', '\t•  Einsatz am 24. & 31. Dezember im Betrieb'].join('\n');
    const seen: string[] = [];
    const translated = await preserveStructuredTranslation(source, async (text) => { seen.push(text); return text.toUpperCase(); });
    expect(countListItems(translated)).toBe(countListItems(source));
    expect(translated.split('\n')[1].startsWith('\t•  ')).toBe(true);
    expect(seen.every((segment) => segment === segment.trim() && segment.length > 0)).toBe(true);
  });

  it('an empty or multi-line segment keeps the source segment, without doubled spaces, also concurrently', async () => {
    const source = '• Start am 24. & 31. Dezember im Betrieb';
    for (const concurrent of [false, true]) {
      const empty = await preserveStructuredTranslation(source, async () => '', { concurrent });
      const multi = await preserveStructuredTranslation(source, async (text) => `${text}\nzweite Zeile`, { concurrent });
      expect(empty).toBe(source);
      expect(multi).toBe(source);
      expect(empty).not.toMatch(/ {2}/);
    }
  });

  it('leaves lines with HTML on the whole-line path', async () => {
    const html = '<p>Tätigkeiten - Wartung von Anlagen - Reparatur von Maschinen - Prüfung</p>';
    const seen: string[] = [];
    await preserveStructuredTranslation(html, async (text) => { seen.push(text); return text; });
    expect(seen).toHaveLength(1);
  });
});
