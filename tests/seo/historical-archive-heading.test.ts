/**
 * Le pagine archivio storiche (self-healing di jobsSeoPagesPlugin, #10481)
 * mostrano la località nell'<h1>.
 *
 * Misurato sul build f3659686, sezione Zurigo IT: tutti i 3 874 offender
 * job-board di `audit:all/h1-title-duplicates` sono questo template. Il
 * `<title>` è `composeSerpJobTitle(ruolo, azienda, località)`, che scarta la
 * località quando non entra nel budget SERP, e l'h1 era «ruolo — azienda»:
 * su 633 pagine la località era nota ma non compariva da nessuna parte e
 * title e h1 coincidevano. Le 2 295 pagine senza azienda né località (solo lo
 * slug come fonte) restano con title = h1 = ruolo: il dato non c'è.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { historicalArchiveHeading } from '../../build-plugins/shared/historicalArchiveHeading';
import { composeSerpJobTitle } from '../../build-plugins/shared/titleSuffix';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// Casi reali dagli offender di Zurigo (ruolo, azienda, Sede).
const OBSERVED: ReadonlyArray<readonly [string, string, string]> = [
  ['Verkaufer in frischprodukte produktion coop genossenschaft epoy4p', '', 'Winterthur'],
  ['Assistance scientifique en droit public universitat zurich', '', 'Zürich'],
  ['Associate sales schlafzimmerabteilung zurich switzerland', 'IKEA', 'Dietlikon'],
  ['Elektroplaner in elektroingenieur in gebaudetechnik zurich', 'AFRY', 'Zürich'],
];

describe('historicalArchiveHeading', () => {
  it('compone «ruolo — azienda, località» omettendo le parti assenti', () => {
    expect(historicalArchiveHeading('Pianificatore', 'Hitachi Energy', 'Zürich')).toBe('Pianificatore — Hitachi Energy, Zürich');
    expect(historicalArchiveHeading('Pianificatore', '', 'Zürich')).toBe('Pianificatore, Zürich');
    expect(historicalArchiveHeading('Pianificatore', 'Hitachi Energy', '')).toBe('Pianificatore — Hitachi Energy');
    expect(historicalArchiveHeading(' Pianificatore ', ' ', ' ')).toBe('Pianificatore');
  });

  it.each(OBSERVED)('con località nota l\'h1 non coincide più col title: %s', (role, company, location) => {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const title = composeSerpJobTitle(role, company, location, locale);
      expect(norm(historicalArchiveHeading(role, company, location)), `${locale}: ${title}`).not.toBe(norm(title));
    }
  });

  it('il template storico usa l\'helper per l\'h1', () => {
    const src = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');
    const start = src.indexOf('const buildHistoricalArchiveHtml = (');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('return buildSoftLandingHtml(', start));
    expect(body).toContain('`<h1>${esc(historicalArchiveHeading(titleRaw, company, location))}</h1>`');
    expect(body).not.toMatch(/<h1>\$\{esc\(titleRaw\)\}/);
  });
});
