// tests/scripts/lib/discovery/domainAnchor.test.ts
//
// Domain-anchor gate for the discovery suggest source. Born from the
// 2026-05-11 `mobilita-palermo-frontalieri-ticino` incident — bare
// cluster names ("mobilita") expanded into Italian-mainland-city
// completions via Google Suggest and slipped through every downstream
// filter. See scripts/lib/discovery/domainAnchor.mjs for the full
// rationale and token list.

import { describe, expect, it } from 'vitest';

import {
  anchorSeed,
  hasDomainAnchor,
  hasSwissMunicipality,
  CH_MUNICIPALITY_SET,
} from '../../../../scripts/lib/discovery/domainAnchor.mjs';

describe('hasDomainAnchor', () => {
  it('rejects null/empty/non-string inputs', () => {
    expect(hasDomainAnchor(null as unknown as string)).toBe(false);
    expect(hasDomainAnchor(undefined as unknown as string)).toBe(false);
    expect(hasDomainAnchor('')).toBe(false);
    expect(hasDomainAnchor('   ')).toBe(false);
    expect(hasDomainAnchor(42 as unknown as string)).toBe(false);
  });

  it('accepts core domain words (frontalieri, ticino, svizzero, …)', () => {
    expect(hasDomainAnchor('Mobilita frontalieri ticino')).toBe(true);
    expect(hasDomainAnchor('busta paga svizzera')).toBe(true);
    expect(hasDomainAnchor('Frontaliere stipendio')).toBe(true);
    expect(hasDomainAnchor('cross-border tax')).toBe(true);
    expect(hasDomainAnchor('Grenzgänger')).toBe(true);
  });

  it('accepts cross-border concepts (permesso G, AVS, LPP, LAMal, …)', () => {
    expect(hasDomainAnchor('Rinnovo permesso G')).toBe(true);
    expect(hasDomainAnchor('AVS contributi')).toBe(true);
    expect(hasDomainAnchor('LPP secondo pilastro')).toBe(true);
    expect(hasDomainAnchor('LAMal premi 2026')).toBe(true);
    expect(hasDomainAnchor('Telelavoro frontalieri')).toBe(true);
    expect(hasDomainAnchor('Ristorni 2026')).toBe(true);
  });

  it('accepts Ticino toponyms', () => {
    expect(hasDomainAnchor('Mobilita lugano')).toBe(true);
    expect(hasDomainAnchor('Trasporti chiasso confine')).toBe(true);
    expect(hasDomainAnchor('Affitti mendrisio')).toBe(true);
    expect(hasDomainAnchor('Salute locarno')).toBe(true);
    expect(hasDomainAnchor('Bellinzona ospedale')).toBe(true);
  });

  it('accepts other CH cantons commonly referenced in cross-border content', () => {
    expect(hasDomainAnchor('Lavoro a Zurigo')).toBe(true);
    expect(hasDomainAnchor('Ginevra stipendi')).toBe(true);
    expect(hasDomainAnchor('Vallese frontalieri stagionali')).toBe(true);
  });

  it('REJECTS off-topic Italian-city completions (Palermo regression)', () => {
    expect(hasDomainAnchor('mobilita palermo')).toBe(false);
    expect(hasDomainAnchor('salute roma')).toBe(false);
    expect(hasDomainAnchor('pensioni napoli centro')).toBe(false);
    expect(hasDomainAnchor('fiscale catania')).toBe(false);
    expect(hasDomainAnchor('lavoro torino')).toBe(false);
    expect(hasDomainAnchor('mobilita sostenibile bologna')).toBe(false);
  });

  it('REJECTS bare cluster words with no anchor', () => {
    expect(hasDomainAnchor('mobilita')).toBe(false);
    expect(hasDomainAnchor('salute')).toBe(false);
    expect(hasDomainAnchor('pensioni')).toBe(false);
    expect(hasDomainAnchor('fiscale')).toBe(false);
  });

  // 2026-05-11 backfill audit — these slugs were previously rejected
  // (false positives) because the regex was too narrow. Each must now
  // pass hasDomainAnchor. See reports/articles-anchorless-slug-2026-05-11.md
  // for the full list and triage notes.
  describe('audit-driven regression — false positives that MUST now pass', () => {
    const cases: Array<[string, string]> = [
      ['svizzeri (m. plural)', 'svizzeri ottimisti finanze 2026'],
      ['svizzere (f. plural)', 'imprese svizzere e cassa malati'],
      ['frontaliero (m. singular)', 'frontaliero ossolano morto a visp'],
      ['federali (Swiss federal vote)', 'votazioni federali 14 giugno 2026'],
      ['federale (singular)', 'consiglio federale conferma accordo'],
      ['cantonale (TI institutions)', 'malessere polizia cantonale audit'],
      ['secondo pilastro (LPP synonym)', 'svizzeri secondo pilastro casa'],
      ['terzo pilastro', 'terzo pilastro come funziona'],
      ['Friburgo (CH canton)', 'friburgo finale europa league'],
      ['Lucerna (CH city)', 'lapo elkann lucerna 2024'],
      ['Crans-Montana (Vallese CH)', 'crans montana ore straordinarie'],
      ['Visp (Vallese CH)', 'incidente lavoro a visp'],
      ['Cornaredo (Lugano stadium)', 'picnic stadio cornaredo'],
      ['San Antonino (TI)', 'pfas filtrazione san antonino 2026'],
      ['Cardada (Locarno)', 'cardada cimetta riapre bikers'],
      ['Vedeggio (TI valley)', 'aggregazione comuni vedeggio 2026'],
      ['Val d\'Ossola (IT frontalieri source)', 'frontaliere val d\'ossola morto'],
      ['Cislago (varesotto)', 'grandine cislago protezione civile'],
      ['Autostrada A9 (Lugano-Chiasso)', 'autostrada a9 chiusure notturne svizzera'],
      ['swiss (English brand)', 'swiss riduce personale amministrativo'],
    ];
    for (const [label, headline] of cases) {
      it(`accepts: ${label} → "${headline}"`, () => {
        expect(hasDomainAnchor(headline)).toBe(true);
      });
    }
  });

  // Negative regression — these LOOK borderline but are genuinely
  // off-topic. The broader regex must NOT regress and accept them.
  describe('audit-driven regression — true off-topic must STAY rejected', () => {
    const cases: Array<[string, string]> = [
      // Pilastro is a Bologna neighborhood; the article is about a
      // tragic incident there, not the LPP/AVS pension pillar.
      ['Pilastro (Bologna neighborhood, no ordinal)', 'questore bimbo pilastro responsabilita'],
      ['Real Madrid soccer drama', 'real madrid caos rissa tchouameni valverde'],
      ['Sanremo Eurovision', 'sanremo eurovision campione 2026'],
      // LPP S.A. is a Polish apparel retailer (GPW = Warsaw Stock
      // Exchange ticker), not the Swiss Loi LPP pension fund. The
      // googleSuggest.mjs LPP_RETAIL_RE denylist was specifically
      // designed for this collision.
      ['LPP S.A. Polish retailer (no \\b boundary)', 'utili fatturato lppsa gpw'],
      ['Trump tariffs', 'trump dazi corte commercio 2026'],
      ['Iran blackout', 'blackout internet iran 70 giorni'],
    ];
    for (const [label, headline] of cases) {
      it(`rejects: ${label} → "${headline}"`, () => {
        expect(hasDomainAnchor(headline)).toBe(false);
      });
    }
  });
});

describe('hasSwissMunicipality (CH BFS + IT comuni di frontiera)', () => {
  it('loaded both datasets with >2500 normalized entries', () => {
    // ~2,100 CH municipalities + 518 IT comuni di frontiera, minus
    // <MIN_NAME_LEN drops + dedup overlaps. Floor at 2,500.
    expect(CH_MUNICIPALITY_SET.size).toBeGreaterThan(2500);
  });

  it('matches Italian comuni di frontiera (ti.ch official list)', () => {
    expect(hasSwissMunicipality('incidente ad albavilla')).toBe(true);
    expect(hasSwissMunicipality('inter ad appiano gentile')).toBe(true);
    expect(hasSwissMunicipality('cantello dogana svizzera')).toBe(true);
    expect(hasSwissMunicipality('alta valle intelvi')).toBe(true);
  });

  it('matches single-token municipality names across cantons', () => {
    expect(hasSwissMunicipality('lugano centro storico')).toBe(true);
    expect(hasSwissMunicipality('zermatt skilift incidente')).toBe(true);
    expect(hasSwissMunicipality('davos forum economico 2026')).toBe(true);
    // Verbier sits inside the merged "Val de Bagnes" municipality.
    expect(hasSwissMunicipality('val de bagnes turismo invernale')).toBe(true);
  });

  it('matches multi-word municipality names (1-3 token sliding window)', () => {
    expect(hasSwissMunicipality('chiesa di riva san vitale')).toBe(true);
    expect(hasSwissMunicipality('incidente a beinwil am see')).toBe(true);
  });

  it('matches paren-stripped names like "Arni (AG)"', () => {
    expect(hasSwissMunicipality('arni inaugurazione comunale')).toBe(true);
  });

  it('REJECTS plain Italian / international cities not in CH', () => {
    expect(hasSwissMunicipality('mobilita palermo')).toBe(false);
    expect(hasSwissMunicipality('real madrid rissa')).toBe(false);
    expect(hasSwissMunicipality('roma centro città')).toBe(false);
    expect(hasSwissMunicipality('napoli stazione')).toBe(false);
  });

  it('REJECTS short ambiguous names below MIN_NAME_LEN (e.g. "or", "on")', () => {
    // "Or" is a Bern town but it's stripped at load time; testing
    // that random short tokens don't false-trigger.
    expect(hasSwissMunicipality('on or off')).toBe(false);
  });

  it('handles null / empty / non-string input safely', () => {
    expect(hasSwissMunicipality(null as unknown as string)).toBe(false);
    expect(hasSwissMunicipality(undefined as unknown as string)).toBe(false);
    expect(hasSwissMunicipality('')).toBe(false);
  });
});

describe('anchorSeed', () => {
  it('appends " frontalieri" to bare cluster words', () => {
    expect(anchorSeed('mobilita')).toBe('mobilita frontalieri');
    expect(anchorSeed('salute')).toBe('salute frontalieri');
    expect(anchorSeed('pensioni')).toBe('pensioni frontalieri');
  });

  it('is idempotent — already-anchored seeds pass through unchanged', () => {
    expect(anchorSeed('frontaliere')).toBe('frontaliere');
    expect(anchorSeed('permesso G')).toBe('permesso G');
    expect(anchorSeed('mobilita ticino')).toBe('mobilita ticino');
    expect(anchorSeed('LAMal')).toBe('LAMal');
  });

  it('handles empty/non-string input safely', () => {
    expect(anchorSeed('')).toBe('');
    expect(anchorSeed('   ')).toBe('');
    expect(anchorSeed(null as unknown as string)).toBe('');
    expect(anchorSeed(undefined as unknown as string)).toBe('');
  });

  it('trims surrounding whitespace before anchoring', () => {
    expect(anchorSeed('  mobilita  ')).toBe('mobilita frontalieri');
  });
});
