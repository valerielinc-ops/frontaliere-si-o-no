/**
 * Le cinque famiglie del residuo information-gain del 2026-10-02 stanno sopra
 * il floor, misurate sull'HTML che i loro renderer emettono ADESSO.
 *
 * Run 36977215802 di `audit-dist-from-run.yml` (`audit:information-gain`):
 * 20 coorti sotto il floor del 5 %, cinque famiglie di template —
 *
 *   | famiglia                                       | coorti | mediana   |
 *   | scheda valico `/guida-frontaliere/tempi-attesa-dogana/<id>/` | 7 | 0 % |
 *   | archivio mensile `/traffico-dogane/<id>/<YYYY-MM>/`          | 4 | 4,2-4,6 % |
 *   | hub cantonale `/premi-cassa-malati/<cantone>/`              | 4 | 2,5-2,6 % |
 *   | glossario localizzato `/{en,de,fr}/…glossar…/<termine>/`     | 3 | 0 % |
 *   | professione × San Gallo `/de/arbeit-st-gallen-*`, `/en/jobs-st-gallen-*` | 2 | 4,3-4,8 % |
 *
 * Ogni famiglia ha ricevuto il dato che solo lei ha (vedi i moduli importati);
 * questo test rifà PRE-merge la misura che il gate fa post-deploy, con lo
 * stesso motore (`scripts/lib/informationGain.mjs`). Due regole per famiglia:
 * la mediana della coorte sta sopra la soglia pinnata (il misurato meno un
 * punto, come in `information-gain-families-floor.test.ts`), e il blocco nuovo
 * è ciò che la porta lì — la stessa composizione SENZA il blocco resta sotto il
 * floor. La seconda regola è quella che rende il test un osservatore: svuota il
 * blocco e il test diventa rosso.
 *
 * Le due famiglie SSG (scheda valico e glossario) escono da `buildPage()` di
 * `staticPagesPlugin.ts`, che non è richiamabile da solo: qui la pagina è
 * composta con gli stessi ingredienti che `buildPage()` mette nel corpo — h1,
 * lede, i blocchi della pagina e l'editoriale di sezione di
 * `SECTION_EDITORIAL` — cioè esattamente la parte che rendeva le sorelle
 * identiche.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fingerprintPage, scoreCohorts, MIN_COHORT_PAGES } from '@/scripts/lib/informationGain.mjs';
import { SECTION_EDITORIAL } from '@/build-plugins/editorialContent';
import { renderBorderCrossingGuideDetail } from '@/build-plugins/shared/borderCrossingGuideDetail';
import { renderGlossaryTermDetail, localizedGlossaryLede } from '@/build-plugins/shared/glossaryTermDetail';
import {
  borderCrossingLabel,
  buildBorderCrossingDescription,
  buildBorderCrossingTitle,
} from '@/build-plugins/shared/borderCrossingTitle';
import { BORDER_WAIT_CROSSINGS, TOP_5_CROSSINGS } from '@/build-plugins/borderWaitData';
import { generateBorderWaitArchives, type BorderWaitHistoryDay } from '@/build-plugins/borderWaitPagesPlugin';
import { buildArchiveInsightSentences } from '@/build-plugins/borderWaitArchiveInsights';
import { generateHealthPremiumsPages, type HealthPremiumsDataset } from '@/build-plugins/healthPremiumsLandingPlugin';
import { HEALTH_PREMIUM_CANTONS, buildHealthPremiumsCantonPath } from '@/build-plugins/healthPremiumsData';
import { renderProfessionCantonPage } from '@/build-plugins/professionCantonLandings';
import { buildProfessionCantonPath, PROFESSION_CANTON_KEYS } from '@/build-plugins/professionCantonData';
import { ALL_CANTON_PROFESSION_IDS, type AnyProfessionId } from '@/build-plugins/professionLandingsData';
import type { ProfessionJobsSnapshot } from '@/build-plugins/professionJobsAggregate';
import itStats from '@/services/locales/it-stats';

type Locale = 'it' | 'en' | 'de' | 'fr';
type Rendered = { urlPath: string; html: string };
const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'];
const FLOOR = 5;

/** The cohorts of one family, scored the way the dist gate scores them. */
const measure = (pages: Rendered[]) => {
  const fingerprints = pages.map((p) =>
    fingerprintPage(`${p.urlPath.replace(/^\//, '').replace(/\/$/, '')}/index.html`, p.html),
  );
  return scoreCohorts(fingerprints, { minCohortPages: 2 }).cohorts;
};

/** Cohorts the gate would actually gate. */
const gated = (pages: Rendered[]) => measure(pages).filter((c) => c.pages >= MIN_COHORT_PAGES);

const offendersBelow = (pages: Rendered[], min: number) =>
  gated(pages)
    .filter((c) => c.medianIgs < min)
    .map((c) => `${c.label}: ${c.medianIgs.toFixed(1)} % su ${c.pages} pagine`);

const zeroGain = (pages: Rendered[]) =>
  measure(pages)
    .filter((c) => c.zeroGainPages > 0)
    .map((c) => `${c.label}: ${c.zeroGainPages}/${c.pages}`);

// ── SSG composition, the body buildPage() emits ───────────────────────────

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Same raw-vs-escaped rule as the `editorialHtml` mapper in staticPagesPlugin.ts. */
const editorialBlock = (b: string) =>
  /^<(h[1-6]|p|nav|div|details|section|ul|ol|table|figure|aside|blockquote)\b/.test(b)
    ? b
    : /<[a-zA-Z][^>]*>/.test(b)
      ? `<p>${b}</p>`
      : `<p>${escHtml(b)}</p>`;

const composeSsgPage = (p: { title: string; h1: string; lede: string; blocks: string[] }) =>
  `<!doctype html><html><head><title>${escHtml(p.title)}</title></head><body><main><article>` +
  `<h1>${escHtml(p.h1)}</h1><p>${escHtml(p.lede)}</p><div>${p.blocks.map(editorialBlock).join('')}</div>` +
  `</article></main></body></html>`;

// ── 1. Scheda valico ──────────────────────────────────────────────────────

const CROSSING_BASE: Record<Locale, string> = {
  it: '/guida-frontaliere/tempi-attesa-dogana/',
  en: '/en/cross-border-guide/border-waiting-times/',
  de: '/de/grenzgaenger-ratgeber/wartezeiten-grenze/',
  fr: '/fr/guide-frontalier/temps-attente-douane/',
};
const LOCALE_GUIDE_QUALIFIER: Record<Exclude<Locale, 'it'>, string> = {
  en: 'Cross-Border Guide',
  de: 'Grenzgänger-Leitfaden',
  fr: 'Guide Frontalier',
};

const renderCrossingGuideFamily = (locale: Locale, withDetail: boolean): Rendered[] =>
  BORDER_WAIT_CROSSINGS.map((slug) => {
    const label = borderCrossingLabel(slug);
    const title = locale === 'it' ? buildBorderCrossingTitle(label) : `${label} | Frontaliere Ticino`;
    const h1 = locale === 'it' ? `Traffico dogana ${label} — Tempi attesa valico` : `${label} (${LOCALE_GUIDE_QUALIFIER[locale]})`;
    const lede = locale === 'it' ? buildBorderCrossingDescription(label) : `${label} — Frontaliere Ticino`;
    const blocks = [
      ...(withDetail ? renderBorderCrossingGuideDetail({ locale, slug }) : []),
      ...SECTION_EDITORIAL['/guida-frontaliere/tempi-attesa-dogana/'][locale],
    ];
    return { urlPath: `${CROSSING_BASE[locale]}${slug}/`, html: composeSsgPage({ title, h1, lede, blocks }) };
  });

describe('scheda valico (staticPagesPlugin → shared/borderCrossingGuideDetail)', () => {
  // Misurato il 2026-10-02 su questa composizione: 31,6 % (de) - 38,9 % sulle
  // coorti gatate, 0 % senza la scheda. Sulle pagine LIVE di quel giorno, con
  // la scheda innestata nel loro corpo reale (cromo, nav, padding editoriale
  // compresi), 23,1-33,3 % sulle coorti gatate. Soglia = il misurato qui meno
  // un punto.
  const MIN = 30.5;

  for (const locale of LOCALES) {
    it(`${locale}: ogni coorte gatata sta sopra ${MIN} %, senza pagine a gain zero`, () => {
      const pages = renderCrossingGuideFamily(locale, true);
      expect(gated(pages).length, 'nessuna coorte gatata: la famiglia non è stata resa').toBeGreaterThan(0);
      expect(offendersBelow(pages, MIN)).toEqual([]);
      expect(zeroGain(pages)).toEqual([]);
    });
  }

  it('senza la scheda la famiglia torna sotto il floor (il blocco è la causa)', () => {
    const below = LOCALES.flatMap((locale) => gated(renderCrossingGuideFamily(locale, false)))
      .filter((c) => c.medianIgs >= FLOOR);
    expect(below).toEqual([]);
  });

  it('due valichi vicini non hanno la stessa scheda', () => {
    const a = renderBorderCrossingGuideDetail({ locale: 'de', slug: 'anieres' }).join('');
    const b = renderBorderCrossingGuideDetail({ locale: 'de', slug: 'hermance' }).join('');
    expect(a).not.toEqual(b);
    // Il suggerimento tradotto è quello dello SPA, nella lingua della pagina.
    expect(a).toContain('Veigy-Foncenex');
    expect(renderBorderCrossingGuideDetail({ locale: 'fr', slug: 'buchs-schaan' }).join('')).toContain('Liechtenstein');
  });

  it('i link ai valichi vicini usano il risolutore del chiamante, con il live come ripiego', () => {
    const viaGuide = renderBorderCrossingGuideDetail({
      locale: 'it',
      slug: 'gaggiolo',
      hrefFor: (peer) => `/guida-frontaliere/tempi-attesa-dogana/${peer}/`,
    }).join('');
    expect(viaGuide).toMatch(/href="\/guida-frontaliere\/tempi-attesa-dogana\/[a-z0-9-]+\/"/);
    const fallback = renderBorderCrossingGuideDetail({ locale: 'en', slug: 'gaggiolo', hrefFor: () => undefined }).join('');
    expect(fallback).toMatch(/href="\/en\/border-wait\/[a-z0-9-]+\/today\/"/);
  });

  it('un valico sconosciuto non emette niente', () => {
    expect(renderBorderCrossingGuideDetail({ locale: 'it', slug: 'non-esiste' })).toEqual([]);
  });
});

// ── 2. Glossario ──────────────────────────────────────────────────────────

/** Term ids straight from the SPA glossary strings (no router import: it drags the whole i18n graph). */
const GLOSSARY_TERM_IDS = Object.keys(itStats)
  .map((k) => /^glossary\.terms\.([^.]+)\.title$/.exec(k)?.[1])
  .filter((id): id is string => Boolean(id));

const GLOSSARY_BASE: Record<Locale, string> = {
  it: '/glossario-frontaliere/',
  en: '/en/cross-border-glossary/',
  de: '/de/grenzgaenger-glossar/',
  fr: '/fr/glossaire-frontalier/',
};
const GLOSSARY_QUALIFIER: Record<Locale, string> = { it: 'Glossario', en: 'Glossary', de: 'Glossar', fr: 'Glossaire' };
/** The pre-fix lede of the localized pages: the placeholder this change replaces. */
const PLACEHOLDER_LEDE: Record<Exclude<Locale, 'it'>, (t: string) => string> = {
  en: (t) => `Definition and explanation of ${t} for cross-border workers (Switzerland–Italy): meaning, context, and practical impact.`,
  de: (t) => `Definition und Erklärung von ${t} für Grenzgänger (Schweiz–Italien): Bedeutung, Kontext und praktische Auswirkung.`,
  fr: (t) => `Définition et explication de ${t} pour travailleurs frontaliers (Suisse–Italie) : signification, contexte et impact pratique.`,
};

const termSlug = (id: string) => id.replace(/_/g, '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const renderGlossaryFamily = (locale: Exclude<Locale, 'it'>, withDetail: boolean): Rendered[] =>
  GLOSSARY_TERM_IDS.map((id) => {
    const term = id.replace(/_/g, ' ');
    const title = `${term} (${GLOSSARY_QUALIFIER[locale]}) | Frontaliere Ticino`;
    const h1 = `${term} (${GLOSSARY_QUALIFIER[locale]})`;
    const lede = withDetail ? (localizedGlossaryLede(id, locale) ?? PLACEHOLDER_LEDE[locale](term)) : PLACEHOLDER_LEDE[locale](term);
    const blocks = [
      ...(withDetail ? renderGlossaryTermDetail(id, locale) : []),
      ...SECTION_EDITORIAL['/glossario-frontaliere/'][locale],
    ];
    return { urlPath: `${GLOSSARY_BASE[locale]}${termSlug(id)}/`, html: composeSsgPage({ title, h1, lede, blocks }) };
  });

describe('glossario localizzato (staticPagesPlugin → shared/glossaryTermDetail)', () => {
  // Misurato il 2026-10-02 su questa composizione: 37,5-41,2 % sulle tre
  // locali (27-29 % sulle pagine live con il blocco innestato), 0 % senza.
  // Soglia = misurato - 1.
  const MIN = 36.5;

  it('copre tutti i termini del glossario SPA', () => {
    expect(GLOSSARY_TERM_IDS.length).toBeGreaterThanOrEqual(40);
  });

  for (const locale of ['en', 'de', 'fr'] as const) {
    it(`${locale}: la coorte sta sopra ${MIN} %, senza pagine a gain zero`, () => {
      const pages = renderGlossaryFamily(locale, true);
      expect(gated(pages).length).toBeGreaterThan(0);
      expect(offendersBelow(pages, MIN)).toEqual([]);
      expect(zeroGain(pages)).toEqual([]);
    });

    it(`${locale}: senza definizione ed esempio la coorte resta sotto il floor`, () => {
      expect(gated(renderGlossaryFamily(locale, false)).filter((c) => c.medianIgs >= FLOOR)).toEqual([]);
    });
  }

  it('ogni termine ha definizione ed esempio in tutte e quattro le lingue', () => {
    const missing = GLOSSARY_TERM_IDS.flatMap((id) =>
      LOCALES.filter((l) => renderGlossaryTermDetail(id, l).length < 3).map((l) => `${l}:${id}`),
    );
    expect(missing).toEqual([]);
  });

  it('la pagina tedesca dà il termine italiano originale, quella italiana gli equivalenti', () => {
    expect(renderGlossaryTermDetail('ainp', 'de').join('')).toContain('AINP (Infortunio)');
    expect(renderGlossaryTermDetail('ainp', 'it').join('')).toContain('NBU (Nichtberufsunfall)');
    expect(localizedGlossaryLede('ainp', 'de')).toMatch(/^NBU \(Nichtberufsunfall\) — /);
  });
});

// ── 3. Archivio mensile dei valichi ───────────────────────────────────────

/** Deterministic 0..1 from a string. */
const unit = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
};

/**
 * Three past months of hourly history for the archived crossings, relative to
 * today (no absolute dates: the archive only publishes months before the
 * current one). Commuter peaks at 07-08 and 17-18, a weekday effect and a
 * per-crossing base — all derived from a hash, so the fixture is stable.
 */
const syntheticHistory = (): BorderWaitHistoryDay[] => {
  const now = new Date();
  const days: BorderWaitHistoryDay[] = [];
  for (let back = 3; back >= 1; back -= 1) {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const month = first.getUTCMonth();
    for (let d = new Date(first); d.getUTCMonth() === month; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10);
      const weekday = (d.getUTCDay() + 6) % 7;
      const perCrossing: BorderWaitHistoryDay['perCrossing'] = {};
      for (const crossing of TOP_5_CROSSINGS) {
        const base = 2 + 10 * unit(crossing);
        perCrossing[crossing] = Array.from({ length: 24 }, (_, hour) => {
          if (hour < 5 || hour > 21) return null;
          const peak = hour === 7 || hour === 8 || hour === 17 || hour === 18 ? 2.5 : 1;
          const weekdayFactor = weekday >= 5 ? 0.5 + unit(`${crossing}:${weekday}`) : 0.8 + unit(`${crossing}:${weekday}`);
          const avg = Math.round(base * peak * weekdayFactor * (0.6 + 0.8 * unit(`${crossing}:${date}:${hour}`)));
          return { min: 0, avg, max: avg * 2, samples: 4 };
        });
      }
      days.push({ date, perCrossing });
    }
  }
  return days;
};

describe('archivio mensile dei valichi (borderWaitPagesPlugin → borderWaitArchiveInsights)', () => {
  const history = syntheticHistory();
  const pages = generateBorderWaitArchives({ history, today: new Date() });
  const byLocale = (locale: Locale): Rendered[] =>
    Object.entries(pages)
      .filter(([p]) => (locale === 'it' ? !/^\/(en|de|fr)\//.test(p) : p.startsWith(`/${locale}/`)))
      .map(([urlPath, html]) => ({ urlPath, html }));
  // Misurato il 2026-10-02: 25,0-27,8 % su questa fixture; 25,0-29,0 % sui
  // dati reali di `data/border-wait-history/` (era 4,2-4,6 %). Soglia = il
  // misurato sulla fixture meno un punto.
  const MIN = 24;

  for (const locale of LOCALES) {
    it(`${locale}: ogni coorte sta sopra ${MIN} %, senza pagine a gain zero`, () => {
      const rendered = byLocale(locale);
      expect(rendered.length).toBe(TOP_5_CROSSINGS.length * 3);
      expect(gated(rendered).length).toBeGreaterThan(0);
      expect(offendersBelow(rendered, MIN)).toEqual([]);
      expect(zeroGain(rendered)).toEqual([]);
    });
  }

  it('dice il mese in parole: giorni della settimana ordinati, giorno peggiore, mese precedente', () => {
    const months = [...new Set(history.map((d) => d.date.slice(0, 7)))].sort();
    const sentences = buildArchiveInsightSentences({ locale: 'it', crossing: 'chiasso-brogeda', monthKey: months[1], history });
    expect(sentences.join(' ')).toMatch(/dal più carico al più scorrevole/);
    expect(sentences.join(' ')).toMatch(/Il giorno con l’attesa media più alta è stato/);
    expect(sentences.join(' ')).toMatch(/^.*Rispetto a .+ la media mensile/m);
    // Il primo mese dell'archivio non ha un precedente: la frase manca, non viene inventata.
    const first = buildArchiveInsightSentences({ locale: 'it', crossing: 'chiasso-brogeda', monthKey: months[0], history });
    expect(first.join(' ')).not.toMatch(/Rispetto a/);
  });

  it('un mese senza osservazioni non promette niente', () => {
    expect(buildArchiveInsightSentences({ locale: 'de', crossing: 'gaggiolo', monthKey: '1999-01', history })).toEqual([]);
  });
});

// ── 4. Hub cantonale dei premi cassa malati ───────────────────────────────

const HEALTH_DATA = (() => {
  try {
    const load = (y: number) => JSON.parse(readFileSync(`data/health-premiums/${y}.json`, 'utf-8')) as HealthPremiumsDataset;
    const current = load(2026);
    return Object.keys(current.premiums ?? {}).length > 0 ? { current, prior: load(2025), oldest: load(2024) } : null;
  } catch {
    return null;
  }
})();

describe('hub cantonale premi cassa malati (healthPremiumsLandingPlugin)', () => {
  const run = HEALTH_DATA ? it : it.skip;
  // Misurato il 2026-10-02 su `data/health-premiums/` reale: 12,2-13,1 % sulle
  // coorti gatate delle quattro lingue (era 2,3-2,6 %). Soglia = misurato - 1.
  const MIN = 11.2;

  const render = (withPrior: boolean) => {
    const { pages } = generateHealthPremiumsPages({
      dataset: HEALTH_DATA!.current,
      priorDataset: withPrior ? HEALTH_DATA!.prior : null,
      oldestDataset: withPrior ? HEALTH_DATA!.oldest : null,
      today: new Date(),
    });
    return (locale: Locale): Rendered[] =>
      HEALTH_PREMIUM_CANTONS.map((c) => buildHealthPremiumsCantonPath(locale, c))
        .filter((p) => typeof pages[p] === 'string')
        .map((urlPath) => ({ urlPath, html: pages[urlPath] }));
  };

  run(`ogni coorte gatata dell'hub sta sopra ${MIN} % in tutte le lingue`, () => {
    const byLocale = render(true);
    for (const locale of LOCALES) {
      const pages = byLocale(locale);
      expect(gated(pages).length, `${locale}: nessuna coorte gatata`).toBeGreaterThan(0);
      expect(offendersBelow(pages, MIN), locale).toEqual([]);
      expect(zeroGain(pages), locale).toEqual([]);
    }
  });

  run("nomina i cantoni vicini in classifica e le casse agli estremi, nella lingua della pagina", () => {
    const de = render(true)('de').find((p) => p.urlPath.endsWith('/bern/'))!;
    expect(de.html).toContain('im Kantonsvergleich: Medianprämie Erwachsene');
    expect(de.html).toMatch(/sind die günstigsten Kassen im Kanton [^<]+ und [^<]+\./);
    expect(de.html).toContain('Veränderung seit 2025');
  });
});

// ── 5. Professione × cantone, una coorte di UN cantone ────────────────────

/** Deterministic, well-spread live count per (canton, profession). */
const liveCount = (canton: string, id: string) => Math.floor(unit(`${canton}:${id}`) * 60);
const EMPLOYERS = ['Alpha AG', 'Beta SA', 'Gamma GmbH', 'Delta AG', 'Epsilon SA', 'Zeta GmbH'];
const snapshot = (canton: string, id: AnyProfessionId): ProfessionJobsSnapshot => {
  const n = liveCount(canton, id);
  return {
    liveCount: n,
    fresh30Count: n % 7,
    medianSalaryChf: 60000 + (n % 13) * 1000,
    featured: [],
    // Gli stessi datori ovunque: il gain non deve poter venire da qui.
    topEmployers: EMPLOYERS.slice(0, 2).map((name, i) => ({ name, count: Math.max(1, n - i) })),
  };
};

describe('professione × cantone: le pagine di UN cantone si distinguono fra loro', () => {
  const byCanton: Record<string, Partial<Record<AnyProfessionId, ProfessionJobsSnapshot>>> = {};
  for (const k of PROFESSION_CANTON_KEYS) {
    byCanton[k] = {};
    for (const id of ALL_CANTON_PROFESSION_IDS) byCanton[k][id] = snapshot(k, id);
  }
  // San Gallo è la coorte che il gate ha visto da sola (`st` sotto i 3
  // caratteri non è mascherato, quindi l'h1 di San Gallo fa template a sé).
  const renderCanton = (locale: Locale, withAcross: boolean): Rendered[] =>
    ALL_CANTON_PROFESSION_IDS.filter((id) => (byCanton.SG[id]?.liveCount ?? 0) >= 3).map((id) => ({
      urlPath: buildProfessionCantonPath(locale, 'SG', id),
      html: renderProfessionCantonPage({
        locale,
        cantonKey: 'SG',
        id,
        snapshot: byCanton.SG[id]!,
        cantonProfessions: byCanton.SG,
        professionAcrossCantons: withAcross
          ? Object.fromEntries(PROFESSION_CANTON_KEYS.map((k) => [k, byCanton[k][id]!]))
          : undefined,
        distDir: '/tmp/information-gain-remainder',
      }).html,
    }));

  // Misurato il 2026-10-02 su questo corpus sintetico: 8,9-10,8 % con il
  // confronto fra cantoni, 4,3-5,9 % senza. Soglia = il minimo misurato meno
  // un punto, sopra il valore senza blocco.
  const MIN = 7.9;

  for (const locale of LOCALES) {
    it(`${locale}: la coorte di San Gallo sta sopra ${MIN} % con il confronto fra cantoni`, () => {
      const withBlock = measure(renderCanton(locale, true)).sort((a, b) => b.pages - a.pages)[0];
      const without = measure(renderCanton(locale, false)).sort((a, b) => b.pages - a.pages)[0];
      expect(withBlock.medianIgs).toBeGreaterThanOrEqual(MIN);
      expect(withBlock.medianIgs).toBeGreaterThan(without.medianIgs);
      expect(withBlock.zeroGainPages).toBe(0);
    });
  }

  it('il confronto nomina gli altri cantoni e linka solo pagine sopra il floor', () => {
    const page = renderCanton('de', true)[0];
    expect(page.html).toContain('der Vergleich mit den anderen Kantonen');
    const links = [...page.html.matchAll(/href="(\/de\/arbeit-[a-z-]+\/)"/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    // Nessun link verso una coppia sotto il floor (sarebbe un bridge noindex).
    for (const k of PROFESSION_CANTON_KEYS) {
      for (const id of ALL_CANTON_PROFESSION_IDS) {
        if ((byCanton[k][id]?.liveCount ?? 0) < 3) {
          expect(links).not.toContain(buildProfessionCantonPath('de', k, id));
        }
      }
    }
  });
});
