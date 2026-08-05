/**
 * Fiscal-regime parametricity for the border-municipality families (#4545).
 *
 * The premise of #4545 is that each border has a STRUCTURALLY different
 * cross-border tax regime, so the generator must be parametric on the regime
 * rather than an Italian template with the names swapped. Publishing the wrong
 * regime for a border is worse than publishing no page: it is a factually
 * false claim about tax law, on a monetised site.
 *
 * These are the invariants that make "parametric" true rather than asserted:
 *
 *   1. No foreign family reuses the Italy-Switzerland regime's vocabulary or
 *      figures (ristorno, franchigia, IRPEF, addizionale, fasce di confine).
 *   2. Each regime's own distinguishing figures appear ONLY on its own family.
 *      Germany's 4.5% / 60 days must not leak onto Austria, Liechtenstein's
 *      45 days must not leak onto Germany, and so on. This is the assertion
 *      that would have caught "replicate the French template on three
 *      corridors", the plan the rollout started from and had to abandon.
 *   3. Austria's page must state that the frontalieri regime does NOT exist
 *      (Art. 15 §4 abrogated, BGBl. III Nr. 22/2007) — the page's job is to
 *      contradict the expectation the neighbouring corridors create.
 *   4. France carries TWO incompatible regimes and must never present the
 *      applicable one as a consequence of geography. See the regimeBasis
 *      block below for the defect this pins.
 */
import { describe, it, expect } from 'vitest';

import { renderAboveFloorPage as renderFrenchAbove } from '@/build-plugins/frenchBorderMunicipalityPagesPlugin';
import { renderAboveFloorPage as renderGermanAbove } from '@/build-plugins/germanBorderMunicipalityPagesPlugin';
import { renderAboveFloorPage as renderAustrianAbove } from '@/build-plugins/austrianBorderMunicipalityPagesPlugin';
import { renderAboveFloorPage as renderLiechtensteinAbove } from '@/build-plugins/liechtensteinBorderMunicipalityPagesPlugin';

import { FRENCH_ABOVE_FLOOR, FRENCH_BELOW_FLOOR, FRENCH_LOCALES } from '@/build-plugins/frenchBorderMunicipalityData';
import { GERMAN_ABOVE_FLOOR, GERMAN_LOCALES, GERMAN_REGIME_TAX } from '@/build-plugins/germanBorderMunicipalityData';
import { AUSTRIAN_ABOVE_FLOOR, AUSTRIAN_LOCALES, AUSTRIAN_REGIME } from '@/build-plugins/austrianBorderMunicipalityData';
import { LIECHTENSTEIN_ABOVE_FLOOR, LIECHTENSTEIN_LOCALES, LIECHTENSTEIN_REGIME } from '@/build-plugins/liechtensteinBorderMunicipalityData';

const DIST = '/tmp/__border_municipality_regime_dist_does_not_exist__';
const DATE = '2026-08-05';

/** Visible text of a rendered page (tags stripped, whitespace collapsed). */
function textOf(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

interface Page {
  key: string;
  text: string;
}

/**
 * Renders every above-floor commune of a family in every locale. Generic over
 * the family's own municipality/locale types so no `as never` cast is needed —
 * an earlier version cast the render callback and silently rendered only part
 * of the matrix, which turned the contamination assertions into half-checks.
 */
function renderAll<M extends { slug: string }, L extends string>(
  list: readonly M[],
  locales: readonly L[],
  render: (m: M, locale: L) => string,
): Page[] {
  const out: Page[] = [];
  for (const m of list) {
    for (const locale of locales) {
      out.push({ key: `${m.slug}[${locale}]`, text: textOf(render(m, locale)) });
    }
  }
  return out;
}

const FRENCH_PAGES = renderAll(FRENCH_ABOVE_FLOOR, FRENCH_LOCALES, (municipality, locale) =>
  renderFrenchAbove({ municipality, locale, dateStamp: DATE, distDir: DIST }).html,
);
const GERMAN_PAGES = renderAll(GERMAN_ABOVE_FLOOR, GERMAN_LOCALES, (municipality, locale) =>
  renderGermanAbove({ municipality, locale, dateStamp: DATE, distDir: DIST }).html,
);
const AUSTRIAN_PAGES = renderAll(AUSTRIAN_ABOVE_FLOOR, AUSTRIAN_LOCALES, (municipality, locale) =>
  renderAustrianAbove({ municipality, locale, dateStamp: DATE, distDir: DIST }).html,
);
const LIECHTENSTEIN_PAGES = renderAll(LIECHTENSTEIN_ABOVE_FLOOR, LIECHTENSTEIN_LOCALES, (municipality, locale) =>
  renderLiechtensteinAbove({ municipality, locale, dateStamp: DATE, distDir: DIST }).html,
);

const ALL_FOREIGN = [
  ['France', FRENCH_PAGES],
  ['Germany', GERMAN_PAGES],
  ['Austria', AUSTRIAN_PAGES],
  ['Liechtenstein', LIECHTENSTEIN_PAGES],
] as const;

function offenders(pages: Page[], re: RegExp): string[] {
  return pages.filter((p) => re.test(p.text)).map((p) => p.key);
}

describe('no foreign family reuses the Italy-Switzerland regime', () => {
  // Vocabulary and figures unique to the Italian frontalieri regime. None of
  // these has any meaning on the FR/DE/AT/LI borders, so a hit means the
  // Italian template leaked in.
  const ITALIAN_MARKERS: [string, RegExp][] = [
    ['ristorno', /\bristorn/i],
    ['franchigia', /\bfranchigi/i],
    ['IRPEF', /\bIRPEF\b/i],
    ['addizionale', /\baddizional/i],
    ['fascia di confine', /\bfasc[ei] (?:di )?(?:confine|frontalier)/i],
    ['20 km Italian border zone', /\bzona di (?:confine|frontiera) dei 20\b/i],
    ['accordo Italia-Svizzera 2020', /accordo (?:italia|italo)[- ]svizzer/i],
  ];

  it.each(ALL_FOREIGN)('%s pages contain no Italian-regime marker', (_name, pages) => {
    const hits: string[] = [];
    for (const [label, re] of ITALIAN_MARKERS) {
      const found = offenders(pages as Page[], re);
      if (found.length) hits.push(`${label}: ${found.slice(0, 3).join(', ')} (+${Math.max(0, found.length - 3)} more)`);
    }
    expect(hits).toEqual([]);
  });
});

describe("each regime's distinguishing figures stay on their own family", () => {
  // Germany's 4.5% withholding and 60-day non-return rule. The day matcher
  // spans the intervening words each locale puts between the number and the
  // noun ("60 non-return days", "60 Nichtrückkehrtage", "60 jours de
  // non-retour") — a `60\s*days` matcher silently matches only two locales
  // out of four and half-passes.
  const GERMAN_RATE = /\b4[.,]5\s*%/;
  const DAY_NOUN = '(?:giorni|days|Tage|jours|rientro|return|Rückkehr|retour)';
  const GERMAN_DAYS = new RegExp(`\\b60\\b[^.]{0,40}${DAY_NOUN}`, 'i');
  const LIECHTENSTEIN_DAYS = new RegExp(`\\b45\\b[^.]{0,40}${DAY_NOUN}`, 'i');
  // Austria's inter-state compensation share.
  const AUSTRIAN_COMPENSATION = /\b12[.,]5\s*%/;
  /** A sentence that names Germany is contrasting with it, not claiming it. */
  const REFERENCES_GERMANY = /(?:tedesc|german|allemand|deutsch)/i;

  it('the German rate and day-threshold appear on every German page and locale', () => {
    expect(GERMAN_REGIME_TAX.quellensteuerRate).toBe(0.045);
    expect(GERMAN_REGIME_TAX.nonReturnThresholdDaysPerYear).toBe(60);
    expect(GERMAN_PAGES.length).toBe(GERMAN_ABOVE_FLOOR.length * GERMAN_LOCALES.length);
    expect(offenders(GERMAN_PAGES, GERMAN_RATE).length).toBe(GERMAN_PAGES.length);
    expect(offenders(GERMAN_PAGES, GERMAN_DAYS).length).toBe(GERMAN_PAGES.length);
  });

  it('the German rate never appears on Austrian or Liechtenstein pages', () => {
    expect(offenders(AUSTRIAN_PAGES, GERMAN_RATE)).toEqual([]);
    expect(offenders(LIECHTENSTEIN_PAGES, GERMAN_RATE)).toEqual([]);
  });

  /**
   * Austria has NO non-return threshold and Liechtenstein's is 45 days, so
   * neither may present the German 60-day rule as its own. Liechtenstein does
   * mention it — deliberately, to warn against assuming the analogy ("the
   * source does not say what happens after the threshold; do not analogize to
   * the German 60-day consequence"). That is correct content, so the check is
   * that any 60-day mention is a CONTRAST naming Germany, never a bare claim.
   */
  it('never presents the German 60-day threshold as the Austrian or Liechtenstein rule', () => {
    for (const [name, pages] of [['Austria', AUSTRIAN_PAGES], ['Liechtenstein', LIECHTENSTEIN_PAGES]] as const) {
      const bareClaims = pages.filter((p) => {
        const sentences = p.text.split(/(?<=[.!?])\s+/).filter((s) => GERMAN_DAYS.test(s));
        return sentences.some((s) => !REFERENCES_GERMANY.test(s));
      });
      expect(bareClaims.map((p) => `${name}/${p.key}`)).toEqual([]);
    }
  });

  it("Liechtenstein's 45-day threshold appears on its own pages and never on German or Austrian ones", () => {
    expect(LIECHTENSTEIN_REGIME.nonReturnThresholdDaysPerYear).toBe(45);
    expect(offenders(LIECHTENSTEIN_PAGES, LIECHTENSTEIN_DAYS).length).toBe(LIECHTENSTEIN_PAGES.length);
    expect(offenders(GERMAN_PAGES, LIECHTENSTEIN_DAYS)).toEqual([]);
    expect(offenders(AUSTRIAN_PAGES, LIECHTENSTEIN_DAYS)).toEqual([]);
  });

  it("Austria's inter-state compensation share never appears on the other families", () => {
    expect(AUSTRIAN_REGIME.interStateCompensationRate).toBe(0.125);
    expect(offenders(GERMAN_PAGES, AUSTRIAN_COMPENSATION)).toEqual([]);
    expect(offenders(LIECHTENSTEIN_PAGES, AUSTRIAN_COMPENSATION)).toEqual([]);
    expect(offenders(FRENCH_PAGES, AUSTRIAN_COMPENSATION)).toEqual([]);
  });
});

describe('Austria — the regime was abrogated, and the page must say so', () => {
  it('models the absence of a frontalieri regime rather than a variant of one', () => {
    expect(AUSTRIAN_REGIME.hasSpecialRegime).toBe(false);
    expect(AUSTRIAN_REGIME.hasReducedRate).toBe(false);
    expect(AUSTRIAN_REGIME.hasBorderZoneRestriction).toBe(false);
    expect(AUSTRIAN_REGIME.hasNonReturnThreshold).toBe(false);
  });

  it('cites the abrogating instrument on every page', () => {
    const withCitation = AUSTRIAN_PAGES.filter((p) => /BGBl\.?\s*III\s*Nr\.?\s*22\/2007/i.test(p.text));
    expect(withCitation.length).toBe(AUSTRIAN_PAGES.length);
  });

  it('frames the OECD 183-day rule as unrelated to commuter status wherever it mentions it', () => {
    // 183 days is a general short-mission rule; the dataset comment is
    // explicit that it must NOT be presented as a frontalieri threshold. So
    // every sentence carrying it has to also carry the disclaimer.
    const UNRELATED =
      /(?:nulla a che vedere|non è (?:una regola frontalier|legat)|non ha nulla|nothing to do with|unrelated|not (?:a |related)|hat nichts|nichts mit|kein(?:e)? Verbindung|rien à voir|sans (?:rapport|lien)|no (?:relation|connection))/i;
    const unqualified: string[] = [];
    for (const p of AUSTRIAN_PAGES) {
      for (const s of p.text.split(/(?<=[.!?])\s+/)) {
        if (/\b183\b/.test(s) && !UNRELATED.test(s)) unqualified.push(`${p.key}: ${s.slice(0, 90)}`);
      }
    }
    expect(unqualified.slice(0, 5)).toEqual([]);
  });
});

describe('Liechtenstein — residence-exclusive taxation and the real commuting direction', () => {
  it('models exclusive residence-state taxation, not source withholding', () => {
    expect(LIECHTENSTEIN_REGIME.taxationRule).toBe('residence-exclusive');
  });

  it('cites the treaty article on every page', () => {
    const withCitation = LIECHTENSTEIN_PAGES.filter((p) => /0\.672\.951\.43|Art\.?\s*15\s*(?:cpv|par|Abs|al)/i.test(p.text));
    expect(withCitation.length).toBe(LIECHTENSTEIN_PAGES.length);
  });
});

describe('France — two incompatible accords, and neither is a consequence of geography', () => {
  const ALL_FRENCH = [...FRENCH_ABOVE_FLOOR, ...FRENCH_BELOW_FLOOR];

  it('carries both accords in the dataset, keyed by canton of the nearest crossing only as an indication', () => {
    expect(new Set(ALL_FRENCH.map((m) => m.regime))).toEqual(new Set(['geneve', 'huit-cantons']));
  });

  /**
   * The defect this pins: `regime` was derived from the canton of the NEAREST
   * CROSSING, but the applicable accord follows the canton of EMPLOYMENT.
   * Divonne-les-Bains (Pays de Gex, Ain) routes to Crassier-Divonne on the VD
   * border, so it was labelled 'huit-cantons' — telling a commuter who works
   * in Geneva that France taxes their full Swiss income. Publier (Chablais)
   * had the same failure via Saint-Gingolph on the VS border, while
   * Thonon-les-Bains 5 km away was labelled 'geneve'.
   *
   * Departments bordering both canton Geneva and an accord-1983 canton are
   * therefore marked 'dual', and their pages present both regimes.
   */
  it('marks communes in departments that border both regimes as dual', () => {
    const byName = new Map(ALL_FRENCH.map((m) => [m.name, m]));
    for (const name of ['Divonne-les-Bains', 'Publier', 'Annemasse', 'Saint-Genis-Pouilly']) {
      expect(byName.get(name)?.regimeBasis, `${name} should be dual`).toBe('dual');
    }
    // Doubs / Jura / Territoire de Belfort border only accord-1983 cantons.
    for (const name of ['Pontarlier', 'Morteau', 'Delle']) {
      expect(byName.get(name)?.regimeBasis, `${name} should be accord-1983-only`).toBe('accord-1983-only');
    }
  });

  it('derives regimeBasis from the department, never from the nearest crossing canton', () => {
    for (const m of ALL_FRENCH) {
      const expected = m.dept === '01' || m.dept === '74' ? 'dual' : 'accord-1983-only';
      expect(m.regimeBasis, `${m.name} (dept ${m.dept})`).toBe(expected);
    }
    // Proof the two keys really differ: dual communes exist whose nearest
    // canton is an accord-1983 canton. Deriving from `canton` would have
    // classified exactly these wrongly.
    const wouldHaveBeenWrong = ALL_FRENCH.filter((m) => m.regimeBasis === 'dual' && m.regime === 'huit-cantons');
    expect(wouldHaveBeenWrong.map((m) => m.name).sort()).toEqual(['Divonne-les-Bains', 'Publier']);
  });

  it('never claims the regime is decided by the nearest border canton', () => {
    // The exact false rule that shipped, in all four locales.
    const FALSE_RULE =
      /(?:determinato dal cantone svizzero di confine più vicino|determined by the nearest Swiss border canton|bestimmt vom nächstgelegenen Schweizer Grenzkanton|déterminé par le canton suisse frontalier le plus proche)/i;
    expect(offenders(FRENCH_PAGES, FALSE_RULE)).toEqual([]);
  });

  it('states the canton-of-employment rule on every page and locale', () => {
    const RULE =
      /(?:cantone svizzero in cui lavori|canton where you work|Kanton ab, in dem Sie arbeiten|canton suisse où vous travaillez)/i;
    const missing = FRENCH_PAGES.filter((p) => !RULE.test(p.text)).map((p) => p.key);
    expect(missing).toEqual([]);
  });

  it('presents BOTH accords on dual-basis pages, and does not single one out', () => {
    const dualSlugs = new Set(FRENCH_ABOVE_FLOOR.filter((m) => m.regimeBasis === 'dual').map((m) => m.slug));
    const dualPages = FRENCH_PAGES.filter((p) => dualSlugs.has(p.key.split('[')[0]));
    expect(dualPages.length).toBeGreaterThan(0);
    for (const p of dualPages) {
      expect(/1973/.test(p.text), `${p.key} should describe the 1973 arrangement`).toBe(true);
      expect(/1983/.test(p.text), `${p.key} should describe the 1983 accord`).toBe(true);
      // Both mechanisms' figures: Geneva's 3.5% retrocession and the 1983
      // accord's 4.5% compensation.
      expect(/3[.,]5\s*%/.test(p.text), `${p.key} should carry the Geneva retrocession`).toBe(true);
      expect(/4[.,]5\s*%/.test(p.text), `${p.key} should carry the 1983 compensation`).toBe(true);
    }
  });

  it('leaves single-regime pages describing only their own accord', () => {
    const singleSlugs = new Set(
      FRENCH_ABOVE_FLOOR.filter((m) => m.regimeBasis === 'accord-1983-only').map((m) => m.slug),
    );
    const singlePages = FRENCH_PAGES.filter((p) => singleSlugs.has(p.key.split('[')[0]));
    expect(singlePages.length).toBeGreaterThan(0);
    for (const p of singlePages) {
      expect(/1983/.test(p.text), `${p.key} should describe the 1983 accord`).toBe(true);
    }
  });

  it('never asserts that a French commune is located in a Swiss canton', () => {
    // The original copy read "{commune} è nel canton Ginevra" — a French
    // commune is not in canton Geneva; it meant "is in the Geneva regime".
    const IN_SWISS_CANTON =
      /(?:è nel canton(?:e)? Ginevra|is in canton Geneva|liegt im Kanton Genf|est dans le canton de Genève)/i;
    expect(offenders(FRENCH_PAGES, IN_SWISS_CANTON)).toEqual([]);
  });
});
