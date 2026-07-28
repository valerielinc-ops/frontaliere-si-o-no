/**
 * Tests for scripts/lib/article-factuality-gates.mjs — the deterministic
 * factuality gates added after the 2026-07-28 incident on the article
 * `frontalieri-altre-tasse-2026` (run 30350429920).
 *
 * The article was generated from ilgiorno.it/sondrio/cronaca/caso-frontalieri-altre-tasse,
 * a source that says Ticino now taxes opt-in-Omnibus frontalieri at 100% OF THE
 * WITHHOLDING TABLES (A/B/C/H) rather than the reduced 80%, on top of the Italian
 * 25% substitute tax. The shipped article read "100%" as "100% of gross salary".
 *
 * Each `describe` below pins one real defect from that article, plus the
 * negative case that must NOT fire — these gates block publication, so a false
 * positive stalls the content pipeline just as badly as a miss.
 *
 * Fixtures use the real strings that shipped, not paraphrases.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseItalianNumber,
  detectTruncation,
  checkInlineArithmetic,
  checkTaxPlausibility,
  checkCrossSectionNumericConflicts,
  checkFabricatedInstitutionAcronyms,
  checkContradictoryNormDates,
  checkSourceFreshness,
  extractSourceAnchors,
  checkSourceFidelity,
  runFactualityGates,
  formatRemediation,
  formatItalianNumber,
  FACT_CHECK_CATEGORIES,
} from '../scripts/lib/article-factuality-gates.mjs';

const codes = (issues: any[]) => issues.map((i) => i.code);

describe('parseItalianNumber', () => {
  it('reads thousands separators and decimal commas', () => {
    expect(parseItalianNumber('60.000')).toBe(60000);
    expect(parseItalianNumber('28.920')).toBe(28920);
    expect(parseItalianNumber('0,45')).toBe(0.45);
    expect(parseItalianNumber('0,032')).toBe(0.032);
    expect(parseItalianNumber('4,5')).toBe(4.5);
    expect(parseItalianNumber('1.234,56')).toBeCloseTo(1234.56);
  });

  it('treats a dot not followed by three digits as a decimal point', () => {
    expect(parseItalianNumber('0.45')).toBe(0.45);
  });

  it('returns NaN for non-numbers', () => {
    expect(parseItalianNumber('abc')).toBeNaN();
    expect(parseItalianNumber('')).toBeNaN();
    expect(parseItalianNumber(null as any)).toBeNaN();
  });
});

describe('checkInlineArithmetic', () => {
  // SHIPPED: "un'imposta sulla rendita del 4,5% (0,45 x 60.000 = 27.000 franchi
  // svizzeri)". The product is right; the factor is 10x the stated percentage.
  it('flags a multiplier that contradicts the stated percentage', () => {
    const issues = checkInlineArithmetic(
      "dovrà pagare un'imposta sulla rendita del 4,5% (0,45 x 60.000 = 27.000 franchi svizzeri)",
    );
    expect(codes(issues)).toContain('percent-factor-mismatch');
    expect(issues[0].message).toContain('4,5');
  });

  it('accepts the correct sibling expression from the same article', () => {
    // "un'aliquota fissa del 3,2% (0,032 x 60.000 = 1.920 franchi svizzeri)"
    const issues = checkInlineArithmetic(
      "un'aliquota fissa del 3,2% (0,032 x 60.000 = 1.920 franchi svizzeri)",
    );
    expect(issues).toEqual([]);
  });

  it('flags a product that simply does not hold', () => {
    const issues = checkInlineArithmetic('0,10 x 50.000 = 9.000');
    expect(codes(issues)).toContain('arithmetic-error');
  });

  it('ignores prose without an explicit calculation', () => {
    expect(checkInlineArithmetic('Il 25% dell\'imposta pagata in Svizzera.')).toEqual([]);
  });
});

describe('checkTaxPlausibility', () => {
  // SHIPPED: income 60.000 CHF, "la quota di imposta sarebbe aumentata al 100%,
  // ovvero 60.000 franchi svizzeri" — the core misreading of "100%".
  it('flags a tax equal to gross income', () => {
    const issues = checkTaxPlausibility(
      'Supponiamo che un lavoratore abbia un reddito di 60.000 franchi svizzeri all\'anno. '
      + 'Se optasse per il Decreto Omnibus, la quota di imposta sarebbe aumentata al 100%, ovvero 60.000 franchi svizzeri.',
    );
    expect(codes(issues)).toContain('tax-exceeds-income');
  });

  it('flags an implausibly high but sub-100% tax', () => {
    const issues = checkTaxPlausibility(
      'Con un reddito di 60.000 franchi svizzeri, dovrebbe pagare un\'imposta di 54.000 franchi svizzeri.',
    );
    expect(codes(issues)).toContain('tax-implausible');
  });

  it('accepts a realistic withholding rate', () => {
    const issues = checkTaxPlausibility(
      'Con un reddito di 60.000 franchi svizzeri, l\'imposta alla fonte ammonta a 6.000 franchi svizzeri.',
    );
    expect(issues).toEqual([]);
  });

  it('does not pair amounts that are not presented as a tax', () => {
    const issues = checkTaxPlausibility(
      'Il reddito di 60.000 franchi svizzeri è superiore alla media di 75.000 franchi svizzeri del settore.',
    );
    expect(issues).toEqual([]);
  });
});

describe('checkCrossSectionNumericConflicts', () => {
  // SHIPPED: the same 60.000 CHF scenario was answered 28.920 (body1),
  // 60.000 (body2) and "+6.000" (body3).
  it('flags incompatible answers to the same scenario across sections', () => {
    const issues = checkCrossSectionNumericConflicts({
      body1: 'Un lavoratore che ha guadagnato 60.000 franchi svizzeri dovrà pagare un\'imposta di 28.920 franchi svizzeri.',
      body3: 'Un lavoratore che guadagna 60.000 franchi svizzeri dovrà pagare 6.000 franchi svizzeri in più di imposta.',
    });
    expect(codes(issues)).toContain('contradictory-figures');
  });

  it('does not flag a two-column comparison inside a single section', () => {
    // A legit "current vs projected" table must survive — it lives in one section.
    const issues = checkCrossSectionNumericConflicts({
      body2: '| reddito di 60.000 franchi | imposta attuale 6.000 franchi | imposta prevista 9.000 franchi |',
    });
    expect(issues).toEqual([]);
  });

  it('does not flag consistent figures across sections', () => {
    const issues = checkCrossSectionNumericConflicts({
      body1: 'Con un reddito di 60.000 franchi svizzeri l\'imposta è di 6.000 franchi svizzeri.',
      body3: 'Sul reddito di 60.000 franchi svizzeri si pagano 6.500 franchi svizzeri di imposta.',
    });
    expect(issues).toEqual([]);
  });
});

describe('checkFabricatedInstitutionAcronyms', () => {
  // SHIPPED: "Ufficio federale delle imposte (UFI)" — no such body exists; the
  // federal one is the AFC/ESTV and the source cited the CANTONAL office.
  it('flags an invented federal institution', () => {
    const issues = checkFabricatedInstitutionAcronyms(
      'Secondo i calcoli effettuati dall\'Ufficio federale delle imposte (UFI), circa 2.000 lavoratori...',
    );
    expect(codes(issues)).toContain('fabricated-institution');
    expect(issues[0].message).toContain('UFI');
  });

  it('accepts real institutions', () => {
    expect(checkFabricatedInstitutionAcronyms(
      'L\'Amministrazione federale delle contribuzioni (AFC) ha confermato.',
    )).toEqual([]);
    expect(checkFabricatedInstitutionAcronyms(
      'L\'Ufficio federale di statistica (UST) pubblica i dati.',
    )).toEqual([]);
  });
});

describe('checkContradictoryNormDates', () => {
  // SHIPPED: "Il 1° gennaio 2024 entrerà in vigore il Decreto Omnibus" and
  // "Il Decreto Omnibus è stato varato il 1° gennaio 2023" in the same article.
  it('flags one norm carrying two different dates', () => {
    const issues = checkContradictoryNormDates(
      'Il Decreto Omnibus è stato varato il 1° gennaio 2023. '
      + 'Il Decreto Omnibus è stato varato il 9 agosto 2024.',
    );
    expect(codes(issues)).toContain('contradictory-norm-dates');
  });

  it('accepts a norm mentioned consistently', () => {
    const issues = checkContradictoryNormDates(
      'Il Decreto Omnibus è stato varato il 9 agosto 2024 ed è entrato in vigore il 10 agosto 2024.',
    );
    expect(issues).toEqual([]);
  });
});

describe('checkSourceFreshness', () => {
  // SHIPPED: a 25 January 2026 source published as news on 28 July 2026.
  it('flags a source far older than the publication date', () => {
    const issues = checkSourceFreshness({
      sourceDate: '2026-01-25',
      publishedAt: '2026-07-28T10:45:02.800Z',
    });
    expect(codes(issues)).toContain('stale-source');
    expect(issues[0].severity).toBe('critical');
  });

  it('accepts a same-week source', () => {
    const issues = checkSourceFreshness({
      sourceDate: '2026-07-25',
      publishedAt: '2026-07-28T10:45:02.800Z',
    });
    expect(codes(issues)).not.toContain('stale-source');
  });

  it('flags future tense pointing at an already-past date', () => {
    const issues = checkSourceFreshness({
      publishedAt: '2026-07-28T00:00:00Z',
      sourceDate: '2026-07-27',
      text: 'I frontalieri interessati dovranno presentare una dichiarazione dei redditi entro il 31 marzo 2024.',
    });
    expect(codes(issues)).toContain('past-date-future-tense');
  });

  it('does not flag future tense about a genuinely future date', () => {
    const issues = checkSourceFreshness({
      publishedAt: '2026-07-28T00:00:00Z',
      sourceDate: '2026-07-27',
      text: 'La nuova regola entrerà in vigore il 1 gennaio 2027.',
    });
    expect(codes(issues)).not.toContain('past-date-future-tense');
  });
});

describe('source fidelity', () => {
  // The real source text, trimmed to the passage that carries the anchors.
  const SOURCE = 'Il Canton Ticino alza il tiro e impone ai cosiddetti "vecchi frontalieri dei nuovi Comuni" '
    + 'di pagare una imposta alla fonte del cento per cento. I frontalieri dei nuovi Comuni di confine che '
    + 'opteranno per il meccanismo del Decreto Omnibus (tassazione in Italia con imposta sostitutiva pari al '
    + '25% dell\'imposta alla fonte pagata in Svizzera) dovranno essere tassati in Ticino al 100% (quindi '
    + 'secondo le tabelle A, B, C e H), e non più all\'80% come nuovi frontalieri. I lavoratori che hanno '
    + 'lavorato in Ticino tra il 31 dicembre 2018 e il 17 luglio 2023 con rientro giornaliero, con residenza '
    + 'fiscale in un Comune ricompreso entro i 20 km dal confine.';

  it('extracts the checkable anchors from the source', () => {
    const anchors = extractSourceAnchors(SOURCE);
    expect(anchors).toContain('pct:25');
    expect(anchors).toContain('pct:80');
    expect(anchors).toContain('pct:100');
    expect(anchors).toContain('km:20');
    expect(anchors).toContain('date:2018-12-31');
  });

  // THE ROOT-CAUSE CASE. The shipped article kept 4/6 anchors — a 67% recall
  // that clears the global threshold — while dropping exactly the two rates
  // that make the story legible: the 80% reduced rate and the Italian 25%.
  it('flags an article that dropped the key rates despite passing global recall', () => {
    const article = 'Il Canton Ticino ha deciso di imporre una imposta alla fonte del cento per cento ai '
      + '\'vecchi\' frontalieri. Riguarda chi ha lavorato in Ticino tra il 31 dicembre 2018 e il 17 luglio 2023 '
      + 'con residenza fiscale in un Comune entro i 20 km dal confine.';
    const issues = checkSourceFidelity(article, SOURCE);
    expect(codes(issues)).toContain('source-key-rates-dropped');
  });

  it('accepts an article that preserved the source rates', () => {
    const article = 'Chi opta per il Decreto Omnibus (imposta sostitutiva italiana al 25%) viene tassato in '
      + 'Ticino al 100% delle tabelle invece che all\'80%. Riguarda chi ha lavorato in Ticino tra il '
      + '31 dicembre 2018 e il 17 luglio 2023, residente entro i 20 km dal confine.';
    expect(checkSourceFidelity(article, SOURCE)).toEqual([]);
  });

  it('does not gate on a source too thin to carry anchors', () => {
    expect(checkSourceFidelity('qualsiasi testo', 'fonte narrativa senza numeri.')).toEqual([]);
  });
});

describe('detectTruncation', () => {
  it('flags a clause left open inside its paragraph', () => {
    const issues = detectTruncation(
      'Il lavoratore dovrà pagare un\'imposta del 4,5% (0,45 x 60.000 = 27.000 operative',
    );
    expect(codes(issues)).toContain('unbalanced-parentheses');
  });

  it('flags an unclosed bold marker', () => {
    expect(codes(detectTruncation('Ecco la **checklist operativa'))).toContain('truncated-bold');
  });

  it('flags prose that stops without terminal punctuation', () => {
    expect(codes(detectTruncation(
      'Il frontaliere che risiede entro i venti chilometri dal confine deve presentare la dichiarazione dei redditi entro',
    ))).toContain('incomplete-ending');
  });

  it('accepts well-formed prose, lists and tables', () => {
    expect(detectTruncation('Il lavoratore paga il 3,2% (0,032 x 60.000 = 1.920 franchi).')).toEqual([]);
    expect(detectTruncation('Checklist:\n\n- Presentare la dichiarazione\n- Verificare la residenza')).toEqual([]);
    expect(detectTruncation('| Scenario | Imposta |\n| --- | --- |\n| Omnibus | 6.000 |')).toEqual([]);
  });
});

describe('runFactualityGates', () => {
  it('blocks on any critical and reports every issue', () => {
    const result = runFactualityGates({
      sections: {
        body1: 'Un lavoratore che ha guadagnato 60.000 franchi svizzeri dovrà pagare un\'imposta '
          + 'sulla rendita del 4,5% (0,45 x 60.000 = 27.000 franchi svizzeri).',
        body2: 'Secondo l\'Ufficio federale delle imposte (UFI), con un reddito di 60.000 franchi '
          + 'svizzeri la quota di imposta sale a 60.000 franchi svizzeri.',
      },
      publishedAt: '2026-07-28T00:00:00Z',
    });
    expect(result.passed).toBe(false);
    expect(codes(result.blocking)).toEqual(
      expect.arrayContaining(['percent-factor-mismatch', 'tax-exceeds-income', 'fabricated-institution']),
    );
  });

  it('passes a clean, source-faithful article', () => {
    const result = runFactualityGates({
      sections: {
        body1: 'Chi opta per il Decreto Omnibus viene tassato in Ticino al 100% delle tabelle A, B, C e H '
          + 'invece che all\'80%, con imposta sostitutiva italiana al 25%.',
        body2: 'Con un reddito di 60.000 franchi svizzeri, l\'imposta alla fonte ammonta a 6.000 franchi svizzeri.',
      },
      sourceText: 'Tassati in Ticino al 100% (tabelle A, B, C e H) e non più all\'80%, con imposta '
        + 'sostitutiva pari al 25% dell\'imposta alla fonte pagata in Svizzera, entro i 20 km dal confine.',
      sourceDate: '2026-07-27',
      publishedAt: '2026-07-28T00:00:00Z',
    });
    expect(result.blocking).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe('time-base guard', () => {
  // Most of the residual corpus noise came from pairing a monthly salary with
  // an annual tax figure. Different, known periods are never compared.
  it('does not pair a monthly income with an annual tax', () => {
    const issues = checkTaxPlausibility(
      'Un operaio che guadagna 4.000 CHF al mese dovrà pagare 7.000 CHF all\'anno di imposte.',
    );
    expect(issues).toEqual([]);
  });

  it('still flags an impossible tax when both are stated over the same period', () => {
    const issues = checkTaxPlausibility(
      'Un frontaliere con uno stipendio di 60.000 franchi all\'anno dovrà pagare 72.000 franchi all\'anno di imposte.',
    );
    expect(codes(issues)).toContain('tax-exceeds-income');
  });
});

describe('formatItalianNumber', () => {
  // toLocaleString('it-IT') degrades to "2700" on reduced-ICU Node builds, and
  // these strings are copied into the article by the writer.
  it('groups thousands with dots and keeps a decimal comma', () => {
    expect(formatItalianNumber(2700)).toBe('2.700');
    expect(formatItalianNumber(60000)).toBe('60.000');
    expect(formatItalianNumber(1234567)).toBe('1.234.567');
    expect(formatItalianNumber(0.045)).toBe('0,045');
    expect(formatItalianNumber(900)).toBe('900');
  });
});

describe('formatRemediation', () => {
  // The regeneration loop gets instructions, not complaints: given only a
  // diagnosis the writer's cheapest move is deletion, which is how the incident
  // article shed its real facts and kept the invented ones.
  const gateResult = () => runFactualityGates({
    sections: {
      body1: 'Un lavoratore che ha guadagnato 60.000 franchi svizzeri dovrà pagare un\'imposta '
        + 'del 4,5% (0,45 x 60.000 = 27.000 franchi svizzeri).',
      body2: 'Secondo l\'Ufficio federale delle imposte (UFI), con un reddito di 60.000 franchi '
        + 'svizzeri la quota di imposta sale a 60.000 franchi svizzeri.',
    },
    publishedAt: '2026-07-28T00:00:00Z',
  });

  it('tells the writer to correct rather than delete', () => {
    const out = formatRemediation(gateResult().blocking);
    expect(out).toContain('correggi, non cancellare');
    expect(out).toContain('CORREZIONE RICHIESTA');
  });

  it('supplies the corrected values, not just the diagnosis', () => {
    const out = formatRemediation(gateResult().blocking);
    // 4,5% of 60.000 is 2.700 — the writer should not have to work it out.
    expect(out).toContain('0,045');
    expect(out).toContain('2.700');
  });

  it('explains the misreading behind an impossible tax', () => {
    const out = formatRemediation(gateResult().blocking);
    expect(out).toContain('ALIQUOTA PIENA');
  });

  it('names the real institution when one was invented', () => {
    const out = formatRemediation(gateResult().blocking);
    expect(out).toMatch(/AFC|ESTV/);
  });

  it('falls back to per-category guidance for LLM issues without a fix', () => {
    const out = formatRemediation([
      { claim: 'La Svizzera è membro UE', reason: 'Affermazione falsa', category: 'eu_svizzera', severity: 'critical' },
    ]);
    expect(out).toContain('Accordi Bilaterali');
  });

  it('returns an empty string when there is nothing to fix', () => {
    expect(formatRemediation([])).toBe('');
  });
});

describe('stale source vs. undated source', () => {
  // Covering an older fact is fine; passing it off as breaking news is not.
  const OLD = { sourceDate: '2026-01-25', publishedAt: '2026-07-28T00:00:00Z' };

  it('blocks when the article never says when the fact happened', () => {
    const issues = checkSourceFreshness({
      ...OLD,
      text: 'Il Canton Ticino applica ora l\'aliquota piena ai frontalieri interessati.',
    });
    expect(issues.find((i) => i.code === 'stale-source')?.severity).toBe('critical');
  });

  it('reports but does not block when the article dates the fact explicitly', () => {
    const issues = checkSourceFreshness({
      ...OLD,
      text: 'Da gennaio 2026 l\'ufficio imposte alla fonte del Canton Ticino applica l\'aliquota piena.',
    });
    const stale = issues.find((i) => i.code === 'stale-source');
    expect(stale?.severity).toBe('major');
    expect(stale?.message).toContain('non fuorvia');
  });
});

describe('reviewer follow-ups (PR #4900)', () => {
  // 🔴 Regression the reviewer caught: lastSourcePublishedAt is module-level and
  // was only set on the real-fetch branch, so a Fase-1 news source date could
  // leak into the Fase-2 evergreen article in the same process and block it as
  // stale. fetchPageContent() now clears it first, unconditionally. Asserted at
  // the source level because the function is not exported.
  it('fetchPageContent clears the source date before every early return', () => {
    const src = readFileSync(
      new URL('../scripts/create-article.mjs', import.meta.url),
      'utf-8',
    );
    const fnStart = src.indexOf('async function fetchPageContent(url) {');
    expect(fnStart).toBeGreaterThan(-1);
    const head = src.slice(fnStart, fnStart + 1400);
    const resetAt = head.indexOf("lastSourcePublishedAt = ''");
    const firstEarlyReturn = head.indexOf("if (url.startsWith('stats-bfs://'))");
    expect(resetAt).toBeGreaterThan(-1);
    expect(resetAt).toBeLessThan(firstEarlyReturn);
  });

  // Adversarial check #2: a category present in the prompt but missing from
  // REMEDIATION_BY_CATEGORY silently drops the "CORREZIONE RICHIESTA" line.
  it('every fact-check category has remediation text', () => {
    for (const category of FACT_CHECK_CATEGORIES) {
      const out = formatRemediation([
        { claim: 'un claim di prova sufficientemente lungo', reason: 'motivo', category, severity: 'critical' },
      ]);
      expect(out, `categoria senza remediation: ${category}`).toContain('CORREZIONE RICHIESTA');
    }
  });

  // Adversarial check #1: all-caps furniture in a source must not count as an
  // institution anchor, or recall is measured against noise.
  it('ignores currency, format and editorial all-caps tokens as anchors', () => {
    const anchors = extractSourceAnchors(
      'LEGGI ANCHE: il prelievo in CHF sale al 25%. Scarica il PDF. Fonte ANSA. '
      + "L'OCST conferma l'aliquota all'80%.",
    );
    expect(anchors).toContain('org:OCST');
    for (const noise of ['org:CHF', 'org:PDF', 'org:ANSA', 'org:LEGGI', 'org:ANCHE']) {
      expect(anchors, `token spurio conteggiato: ${noise}`).not.toContain(noise);
    }
  });
});
