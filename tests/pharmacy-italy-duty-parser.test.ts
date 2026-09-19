import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  localDateTimeToItalyIso,
  parseItalyDutySource,
  resolveItalyDutyProvince,
} from '../scripts/lib/pharmacy-italy-duty-parser.mjs';

const sources = JSON.parse(readFileSync(new URL('../data/pharmacy-duties-italy-sources.json', import.meta.url), 'utf8'));
const catalogue = JSON.parse(readFileSync(new URL('../data/pharmacies-italy-border.json', import.meta.url), 'utf8'));
const FIXTURE_DIR = new URL('./fixtures/pharmacy-duties/italy/', import.meta.url);
const FETCHED_AT = '2026-09-15T10:00:00.000Z';

describe('Italian official duty parser', () => {
  it('parses the three official provincial fixture formats and keeps the province', () => {
    const results = sources.sources.map((source: { key: string; fixturePath: string }) => {
      const raw = readFileSync(new URL(`${source.fixturePath}/source.txt`, FIXTURE_DIR), 'utf8');
      return parseItalyDutySource(raw, source, { fetchedAt: FETCHED_AT, asOf: FETCHED_AT, catalogue });
    });

    expect(results.map((result: { province: string }) => result.province)).toEqual(['CO', 'VA', 'VB']);
    // Le aspettative si separano per MODELLO DI COPERTURA: le tre fonti non sono
    // omogenee. Prima questo test pretendeva `coverage: 'partial'` da tutte e
    // tre, cioe' pinnava il difetto — anche VCO, che e' corrections-only e non
    // puo' soddisfare un minimo in giorni-calendario, era incompleta per sempre.
    const [como, varese, vco] = results as Array<{
      duties: unknown[]; observedDuties: unknown[]; errors: string[];
      freshness: string; coverage: string; coverageModel: string;
    }>;

    // Como e Varese sono `full-calendar`: queste fixture coprono pochi giorni,
    // molto sotto il minimo di 300, quindi restano incomplete e non pubblicano.
    // E' l'unico motivo per cui qui la copertura e' `partial`: sui PDF reali
    // valgono 365 e 355 giorni distinti e superano il minimo.
    for (const result of [como, varese]) {
      expect(result.coverageModel).toBe('full-calendar');
      expect(result.duties.length).toBe(0);
      expect(result.observedDuties.length).toBeGreaterThan(0);
      expect(result.errors.some((error) => error.includes('coverage is incomplete'))).toBe(true);
      expect(result.errors.some((error) => error.includes('no operational duty rows published'))).toBe(true);
      expect(result.freshness).toBe('fresh');
      expect(result.coverage).toBe('partial');
    }

    // VCO e' `corrections-only`: il minimo in giorni non si applica, quindi i
    // cambi turno con data esplicita vengono pubblicati.
    expect(vco.coverageModel).toBe('corrections-only');
    expect(vco.errors.some((error) => error.includes('coverage is incomplete'))).toBe(false);
    expect(vco.duties.length).toBeGreaterThan(0);
    expect(vco.coverage).toBe('covered');
    expect(vco.freshness).toBe('fresh');
    expect(results.flatMap((result: { observedDuties: Array<{ province: string }> }) => result.observedDuties).every((duty) => ['CO', 'VA', 'VB'].includes(duty.province))).toBe(true);
  });

  it('uses Europe/Rome, including the autumn DST boundary', () => {
    expect(localDateTimeToItalyIso('15/09/2026', '08:30')).toBe('2026-09-15T06:30:00.000Z');
    expect(localDateTimeToItalyIso('25/10/2026', '08:30')).toBe('2026-10-25T07:30:00.000Z');
  });

  it('requires exactly one coherent province marker', () => {
    expect(resolveItalyDutyProvince('Calendario turni annuale 2026', 'CO').error)
      .toBe('source province marker is missing');
    expect(resolveItalyDutyProvince('Provincia di Como e Provincia di Varese', 'CO').error)
      .toContain('outside CO');
  });

  it('evaluates validity windows on the Europe/Rome calendar date', () => {
    const como = sources.sources.find((source: { province: string }) => source.province === 'CO');
    const result = parseItalyDutySource(
      'PROVINCIA DI COMO\n05/09/2026 Appiano Cavour',
      como,
      { fetchedAt: '2026-06-01T00:30:00.000Z', asOf: '2026-05-31T22:30:00.000Z', catalogue },
    );
    expect(result.errors).not.toContain('official calendar is outside its declared validity window');

    const outOfWindow = parseItalyDutySource(
      'PROVINCIA DI COMO\nDUTY|date=31/05/2026|label=Appiano Cavour|pharmacyId=it-msal-2088|province=CO',
      como,
      { fetchedAt: FETCHED_AT, asOf: FETCHED_AT, catalogue },
    );
    expect(outOfWindow.duties).toEqual([]);
    expect(outOfWindow.errors).toContain('official duty date is outside its declared validity window: 1 row(s)');
  });

  it('fails closed when province evidence is conflicting or an explicit row omits it', () => {
    const como = sources.sources.find((source: { province: string }) => source.province === 'CO');
    expect(resolveItalyDutyProvince('Calendario Provincia di Como e Provincia di Varese', 'CO').error).toContain('outside CO');

    const result = parseItalyDutySource(
      'PROVINCIA DI COMO\nDUTY|date=15/09/2026|label=Appiano Cavour|pharmacyId=it-msal-2088|province=',
      como,
      { fetchedAt: FETCHED_AT, asOf: FETCHED_AT, catalogue },
    );
    expect(result.duties).toEqual([]);
    expect(result.warnings.join(' ')).toContain('missing or conflicting province');
  });

  it('does not publish an unknown or ambiguous source province', () => {
    const result = parseItalyDutySource(
      'DUTY|date=15/09/2026|label=Appiano Cavour|pharmacyId=it-msal-2088|province=VA',
      { ...sources.sources[0], province: 'CO' },
      { fetchedAt: FETCHED_AT, asOf: FETCHED_AT, catalogue },
    );
    expect(result.duties).toEqual([]);
    expect(result.errors).toContain('source contains a province marker outside CO');
  });

  it('rejects an identity alias that belongs to another province', () => {
    const como = sources.sources.find((source: { province: string }) => source.province === 'CO');
    const mismatchedSource = {
      ...como,
      identityAliases: [
        { ...como.identityAliases[0], pharmacyId: 'it-msal-3924' },
        ...como.identityAliases.slice(1),
      ],
    };
    const result = parseItalyDutySource(
      'PROVINCIA DI COMO\nDUTY|date=15/09/2026|label=Appiano Cavour|pharmacyId=it-msal-3924|province=CO',
      mismatchedSource,
      { fetchedAt: FETCHED_AT, asOf: FETCHED_AT, catalogue },
    );
    expect(result.duties).toEqual([]);
    expect(result.observedDuties).toEqual([]);
    expect(result.warnings.join(' ')).toContain('province mismatch');
  });

  it('drops the whole province when one otherwise valid feed row is malformed', () => {
    const como = sources.sources.find((source: { province: string }) => source.province === 'CO');
    const result = parseItalyDutySource(
      [
        'PROVINCIA DI COMO',
        'DUTY|date=15/09/2026|label=Albese|pharmacyId=it-msal-2192|province=CO',
        'DUTY|date=not-a-date|label=Albavilla|pharmacyId=it-msal-2166|province=CO',
      ].join('\n'),
      como,
      { fetchedAt: FETCHED_AT, asOf: FETCHED_AT, catalogue },
    );
    expect(result.duties).toEqual([]);
    expect(result.errors.some((error: string) => error.includes('invalid date'))).toBe(true);
  });
});

/**
 * Guard sul difetto vero: la copertura del calendario si misura sul CALENDARIO,
 * non sulle righe che hanno fatto match con l'anagrafica.
 *
 * Le fixture storiche coprivano 2-4 giorni, quindi ogni fonte falliva il minimo
 * di 300 in modo indistinguibile e 70-contro-300 sembrava identico a
 * 3-contro-300: il difetto era invisibile ai test. Qui il calendario e' ampio
 * (310 giorni) mentre gli alias del catalogo compaiono in DUE soli giorni, cioe'
 * esattamente la forma di una rotazione provinciale reale. Col conteggio vecchio
 * (giorni delle righe aliasate) questo test leggerebbe 2 e la fonte risulterebbe
 * incompleta; col conteggio corretto legge 310 e pubblica.
 */
describe('Italian duty calendar coverage is measured on the calendar', () => {
  const CO_SOURCE = sources.sources.find((entry: { province: string }) => entry.province === 'CO');

  function syntheticComoCalendar(days: number, aliasDays: Record<number, string>) {
    const lines = [
      'Prot. n. 0005986 del 28-05-2026',
      'Provincia di COMO',
      '',
      'TURNI FARMACIE 01.06.2026 - 31.05.2027',
      '',
    ];
    const start = Date.UTC(2026, 5, 1); // 2026-06-01, inside the declared window
    for (let index = 0; index < days; index += 1) {
      const date = new Date(start + index * 86400000);
      const dd = String(date.getUTCDate()).padStart(2, '0');
      const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
      // Le zone non aliasate non devono contenere per caso un'etichetta del
      // catalogo, altrimenti il test misurerebbe qualcos'altro.
      const zones = aliasDays[index] || `Zona Generica ${index}`;
      lines.push(`${dd}/${mm}/${date.getUTCFullYear()} Giorno    ${zones}`);
    }
    return lines.join('\n');
  }

  it('counts calendar days, not alias matches, so a real rotation clears the minimum', () => {
    const raw = syntheticComoCalendar(310, { 5: 'Merone', 200: 'Albese' });
    const parsed = parseItalyDutySource(raw, CO_SOURCE, {
      fetchedAt: FETCHED_AT,
      asOf: FETCHED_AT,
      catalogue,
    });

    // Il calendario copre 310 giorni e supera il minimo di 300...
    expect(parsed.observedCalendarDays).toBe(310);
    expect(parsed.minimumCalendarDays).toBe(300);
    expect(parsed.errors.some((error: string) => error.includes('coverage is incomplete'))).toBe(false);
    expect(parsed.coverage).toBe('covered');

    // ...mentre le farmacie del catalogo compaiono in due soli giorni. E' questa
    // differenza che il conteggio vecchio confondeva col minimo del calendario.
    const aliasDays = new Set(parsed.observedDuties.map((duty: { startsAt: string }) => duty.startsAt.slice(0, 10)));
    expect(aliasDays.size).toBe(2);
    expect(parsed.observedCalendarDays).toBeGreaterThan(aliasDays.size);
    expect(parsed.duties.length).toBeGreaterThan(0);
  });

  it('still reports an incomplete calendar when the source is genuinely truncated', () => {
    // Il gate deve restare capace di bocciare: un PDF troncato (per esempio una
    // sola pagina scaricata) copre pochi giorni e non va pubblicato.
    const raw = syntheticComoCalendar(45, { 5: 'Merone' });
    const parsed = parseItalyDutySource(raw, CO_SOURCE, {
      fetchedAt: FETCHED_AT,
      asOf: FETCHED_AT,
      catalogue,
    });

    expect(parsed.observedCalendarDays).toBe(45);
    expect(parsed.errors.some((error: string) => error.includes('coverage is incomplete: 45/300'))).toBe(true);
    expect(parsed.duties.length).toBe(0);
    expect(parsed.coverage).toBe('partial');
  });
});
