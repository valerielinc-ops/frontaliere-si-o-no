/**
 * seo-ctr-curve.mjs — shared expected-CTR-by-position model + template
 * family registry for the SERP CTR pipeline (issue #4300).
 *
 * Single source of truth used by BOTH scripts/seo-ctr-baseline.mjs (one-off
 * gap analysis) and scripts/monitor-seo-ctr-by-template.mjs (scheduled
 * threshold monitor) — per AGENTS.md sibling-pattern discipline, the
 * expected-CTR curve and the family prefix list must never drift between
 * the two call sites.
 *
 * The curve is a blended organic CTR-by-position benchmark (rounded from
 * publicly published organic CTR studies, e.g. Advanced Web Ranking /
 * Backlinko aggregate curves). It is intentionally coarse — this is a
 * "is this family systematically underperforming its position" signal,
 * not a precise per-query prediction.
 *
 * The weighted-position/CTR ratio math reuses
 * scripts/lib/analytics-opportunity-utils.mjs's weightedAveragePosition() /
 * computeCtr() — the same divide-by-zero-guarded formula
 * aggregateRowsByTemplate() there uses, extracted so the two independent
 * GSC row-aggregation call sites can't drift apart.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { weightedAveragePosition, computeCtr } from './analytics-opportunity-utils.mjs';
// Leaf modules on purpose (issue #7174): `services/jobBoardSlugs.ts` and
// `build-plugins/fuelDailyData.ts` carry the slug tables without dragging in
// the SPA/build graph that importing `services/router.ts` would. These are
// `.ts` sources, so the scripts that import this module run under `npx tsx`,
// not bare `node` (.github/workflows/monitor-seo-ctr-by-template.yml,
// campaign-goal-check.yml).
import { getJobBoardSlugForCanton, getAggregatorJobBoardSlug, parseJobBoardSlug } from '../../services/jobBoardSlugs.ts';
import { FUEL_SECTION_SLUG } from '../../build-plugins/fuelDailyData.ts';

// Index 0 unused — GSC positions are 1-based. Values are CTR fractions
// (0.316 === 31.6%).
const CTR_BY_POSITION = [
  null,
  0.316, 0.155, 0.106, 0.072, 0.056,
  0.044, 0.037, 0.032, 0.028, 0.025,
  0.022, 0.019, 0.017, 0.015, 0.013,
  0.012, 0.011, 0.010, 0.009, 0.008,
];
const TAIL_CTR = 0.006; // position > 20

/**
 * Expected organic CTR (fraction, e.g. 0.037) for a given average position.
 *
 * LINEARLY INTERPOLATED between the integer buckets, not rounded to the
 * nearest one (issue #7412). Rounding made the curve a step function, and
 * because `effectiveTargetCtr()` derives a family's alarm floor from it
 * (`multiple × expectedCtrForPosition(avgPosition)`), every bucket edge was a
 * cliff in the THRESHOLD, not just in the model: the fuel families sit at a
 * weighted position of ~6.5, where a run-to-run drift of a few hundredths
 * across 6.5 flipped the expected CTR between 0.037 (bucket 7) and 0.044
 * (bucket 6) — a 19% jump in the floor. Since a LOWER position number is a
 * BETTER ranking, the cliff fired the alarm precisely on a position
 * IMPROVEMENT, with the snippet unchanged: a structural false positive.
 *
 * Interpolating keeps the curve continuous and still monotonically
 * non-increasing, so the floor now tracks the position smoothly — a marginal
 * ranking move produces a marginal threshold move, and only a real CTR drop
 * (or a large position gain) can cross it. Integer positions are unchanged
 * (exact bucket values), so the model itself is the same benchmark; positions
 * past the last bucket fade into `TAIL_CTR` over one position instead of
 * dropping onto it.
 */
export function expectedCtrForPosition(position) {
  const p = Number(position);
  if (!Number.isFinite(p) || p < 1) return CTR_BY_POSITION[1];
  const lastBucket = CTR_BY_POSITION.length - 1;
  if (p >= lastBucket + 1) return TAIL_CTR;
  const lower = Math.floor(p);
  const fraction = p - lower;
  const lowerCtr = CTR_BY_POSITION[lower];
  if (fraction === 0) return lowerCtr;
  const upperCtr = lower + 1 <= lastBucket ? CTR_BY_POSITION[lower + 1] : TAIL_CTR;
  return lowerCtr + (upperCtr - lowerCtr) * fraction;
}

/**
 * Ratio of actual to expected CTR at a given position. <1 = underperforming
 * the position curve, >1 = overperforming. Returns null when position is
 * not a finite number (can't evaluate).
 */
export function ctrGapRatio(actualCtr, position) {
  const expected = expectedCtrForPosition(position);
  if (!expected) return null;
  return Number(actualCtr) / expected;
}

/**
 * MIN_IMPRESSIONS_TO_MONITOR — the volume above which a TEMPLATE family must
 * be monitored. Enforced by tests/seo-ctr-curve.test.ts against the measured
 * `impressions90d` recorded on each entry, so a high-volume family cannot be
 * silently left out of the monitor again (it already happened once: see the
 * `cerca-lavoro-ticino` entry below).
 *
 * 50k impressions / 90 days ≈ 555/day. Below that a 14-day window carries too
 * few impressions for the weekly check to distinguish a real CTR drop from
 * noise; above it, a single point of CTR is worth thousands of clicks a
 * quarter and the family has to be watched.
 */
export const MIN_IMPRESSIONS_TO_MONITOR = 50_000;

/**
 * Template families targeted by issue #4300, plus the `/de/` locale prefix
 * kept as a report-only reference.
 *
 * FIELDS
 *   kind          'template' = one page template with its own title/description
 *                 generator, i.e. something the monitor's remediation advice can
 *                 actually point at. 'locale' = a cross-cutting language prefix
 *                 that aggregates pages of EVERY template; its CTR cannot be
 *                 attributed to any one generator, so it is exempt from the
 *                 monitored-above-threshold invariant. The test pins `locale` to
 *                 an actual `/xx/` locale root so the exemption cannot be used
 *                 to dodge the invariant by relabelling a template family.
 *                 'listing' = a URL prefix that groups multiple hand-authored,
 *                 editorially distinct pages (each with its own title/meta,
 *                 no shared generator function) rather than one repeatable
 *                 template — e.g. `/vita-in-ticino/` (issue #6306), whose 5
 *                 pages (Fox Town outlet, ponti 2026, calendario scolastico,
 *                 lavoro a Lugano, OSS Svizzera) are each authored individually
 *                 in `build-plugins/editorialContent.ts`. Exempt from the
 *                 monitored-above-threshold invariant for the same reason as
 *                 `locale` (no single remediation target), but — unlike
 *                 `locale` — not pinned to a fixed path shape; a `note` field
 *                 documenting the justification is required instead, so the
 *                 exemption stays auditable rather than a silent escape hatch.
 *   impressions90d  measured GSC impressions over a trailing 90 days — the input
 *                 to the invariant. `measuredOn` records when.
 *   measuredCtr / measuredPosition  the CTR (fraction) and impressions-weighted
 *                 average position of the SAME 90-day measurement that produced
 *                 `impressions90d`. Required on every family that declares
 *                 `targetCtrCurveMultiple`, because those two numbers are the
 *                 only inputs from which the multiple can be re-derived — and
 *                 without them the derivation lives in prose and silently rots
 *                 whenever the curve changes underneath it (issue #7412: the
 *                 rounded→interpolated curve of #7426 left five multiples
 *                 calibrated against expected-CTR values that no longer exist).
 *                 `tests/seo-ctr-curve.test.ts` re-derives every multiple from
 *                 these fields and fails when the declared floor drifts off the
 *                 80%-of-measured-CTR methodology.
 *   targetCtr     absolute CTR floor (fraction). Used as-is when the family
 *                 declares no curve multiple, and as the fallback when GSC
 *                 returns no usable average position. Same 80% rule: it is
 *                 0,8 × `measuredCtr` expressed as an absolute.
 *   targetCtrCurveMultiple  when set, the effective target is
 *                 `multiple × expectedCtrForPosition(avgPosition)` — see
 *                 effectiveTargetCtr() below. Derived as
 *                 `0,8 × measuredCtr / expectedCtrForPosition(measuredPosition)`
 *                 so that at the measured position the floor sits at 80% of the
 *                 measured CTR, i.e. the monitor escalates on a ~20% regression.
 *   pathAliases   optional extra `pathContains`-style substrings that are
 *                 the SAME template under a different locale's URL slug.
 *                 Two distinct shapes both need it: (a) the locale slug drops
 *                 the `/en/`/`/de/`/`/fr/` PREFIX entirely, e.g. the article
 *                 template is `/articoli-frontaliere/` in Italian but
 *                 `/cross-border-articles/` in English and
 *                 `/grenzgaenger-artikel/` in German (see
 *                 `services/router.ts`'s `isArticles` regex and
 *                 `getJobBoardSlugForCanton`/`getAggregatorJobBoardSlug` for
 *                 the job-board equivalents); (b) the locale slug KEEPS the
 *                 prefix but translates the segment after it, e.g.
 *                 `/en/cross-border-guide/…` — `LOCALE_PATH_PREFIXES` below
 *                 strips the prefix for shape (b) but still compares the
 *                 *translated* remaining segment against `pathContains`,
 *                 which never matches, so shape (b) needs `pathAliases` too
 *                 (see `guida-frontaliere`/`tasse-e-pensione` below,
 *                 `services/routeSlugs.data.ts`'s `guida`/`fisco` keys).
 *                 Without this, each locale slug rolls up as its own
 *                 "unregistered family" in `discoverUnregisteredFamilies`
 *                 once it crosses the volume threshold on its own — issue
 *                 #5961. Use `familyPathPrefixes()` below to read
 *                 `pathContains` + `pathAliases` together.
 */
const MANUAL_SEO_CTR_FAMILIES = [
  {
    id: 'articoli-frontaliere',
    label: 'Articoli (blog)',
    pathContains: '/articoli-frontaliere/',
    // EN / DE / FR locale slugs for the same article template (issue #5961).
    pathAliases: ['/cross-border-articles/', '/grenzgaenger-artikel/', '/articles-frontalier/'],
    kind: 'template',
    targetCtr: 0.03,
    monitored: true,
    // GSC 2026-05-13 → 2026-08-08, dataState final: 242.986 imp, CTR 2,03%, pos 7,56.
    impressions90d: 242986,
    measuredOn: '2026-08-11',
  },
  {
    id: 'guida-frontaliere',
    label: 'Guida frontaliere',
    pathContains: '/guida-frontaliere/',
    // EN / DE / FR locale slugs for the same guide template — unlike the
    // articles/job-board aliases above, these keep the `/en|de|fr/` locale
    // PREFIX and translate the segment itself (services/routeSlugs.data.ts's
    // `guida` key: cross-border-guide / grenzgaenger-ratgeber /
    // guide-frontalier), so `LOCALE_PATH_PREFIXES` stripping the prefix
    // alone doesn't reunite them with the Italian segment (issue #5961).
    pathAliases: ['/cross-border-guide/', '/grenzgaenger-ratgeber/', '/guide-frontalier/'],
    kind: 'template',
    targetCtr: 0.035,
    monitored: true,
    // GSC 2026-05-13 → 2026-08-08: 84.951 imp, 1.773 click, CTR 2,09%, pos 9,51.
    impressions90d: 84951,
    measuredOn: '2026-08-11',
  },
  {
    id: 'tasse-e-pensione',
    label: 'Tasse e pensione',
    pathContains: '/tasse-e-pensione/',
    // EN / DE / FR locale slugs for the same tax/pension template — same
    // prefix+translated-segment shape as `guida-frontaliere` above
    // (services/routeSlugs.data.ts's `fisco` key: taxes-and-pension /
    // steuern-und-vorsorge / impots-et-retraite), issue #5961.
    pathAliases: ['/taxes-and-pension/', '/steuern-und-vorsorge/', '/impots-et-retraite/'],
    kind: 'template',
    targetCtr: 0.03,
    monitored: true,
    // GSC 2026-05-13 → 2026-08-08: 45.387 imp, 670 click, CTR 1,48%, pos 6,76.
    // Under MIN_IMPRESSIONS_TO_MONITOR but monitored anyway — the invariant is
    // a floor on what MUST be watched, not a ceiling on what may be.
    impressions90d: 45387,
    measuredOn: '2026-08-11',
  },
  {
    // The single highest-value family on the property, and it sat here with
    // `monitored: false, targetCtr: null` from #4300 onward because the issue
    // cited it as a healthy *benchmark*. Measured 2026-08-11 over GSC
    // 2026-05-13 → 2026-08-08 (dataState final): 911.138 impressioni, 60.373
    // click, CTR 6,63%, posizione media ponderata 8,61 — 2,4× le impressioni e
    // 3,4× i click pesati delle tre famiglie sorvegliate MESSE INSIEME, su
    // pubblico svizzero (CPC 0,17 contro 0,05 dell'italiano). Un punto di CTR
    // qui vale ~9.111 click / 90gg ≈ 3.037 al mese. Non sorvegliarla era la
    // cosa più costosa che questo registro potesse fare.
    id: 'cerca-lavoro-ticino', // cathedral-allow: GSC family identifier for CTR aggregation, not a URL emission site
    label: 'Cerca lavoro Ticino',
    pathContains: '/cerca-lavoro-ticino/',
    // EN / DE / FR legacy TI-only job-board slugs (issue #5961) —
    // `getJobBoardSlugForCanton` in services/router.ts.
    pathAliases: ['/find-jobs-ticino/', '/jobs-im-tessin/', '/trouver-emploi-tessin/'],
    kind: 'template',
    monitored: true,
    // WHY NOT 0.035 like the Italian families: at 6,63% a 3,50% floor is 47%
    // below where the family lives — it could never fire, and an alarm that
    // cannot fire is decoration. WHY NOT the raw position curve either: at
    // position 8,61 the generic organic benchmark expects 2,956%, so this
    // family already beats its position by 2,24× (Swiss job-search intent) and
    // 2,956% would be even more ornamental than 3,50%.
    // So the target is expressed on the family's OWN position↔CTR curve:
    // 80% of the demonstrated 2,24× ratio → 1,79× the position-expected CTR.
    // Today that is 1,79 × 2,956% = 5,29%, i.e. the monitor escalates after a
    // ~20% CTR regression sustained for 2 consecutive weekly runs. Because the
    // target moves with the measured position, a pure ranking loss does NOT
    // fire it — that is deliberate: this monitor answers "is the snippet still
    // earning its position", which is the question its remediation advice
    // (title/description generators) can actually act on.
    // Il 2,8% / 2,37× / 1,9 di prima erano lo stesso calcolo fatto sul bucket
    // ARROTONDATO (posizione 8,61 → bucket 9): #7426 ha reso la curva
    // interpolata e l'atteso a 8,61 non e` piu` quello del bucket 9 (issue
    // #7412). Ri-derivato sulla curva vera, il floor torna all'80% dichiarato:
    // con 1,9 valeva l'84,7% del CTR misurato, cioe` scattava gia` a una
    // regressione del 15,3% invece che del 20%.
    targetCtrCurveMultiple: 1.79,
    // Fallback floor when GSC gives no usable position: 80% of the measured
    // 6,63%, the same 20%-regression trigger expressed as an absolute.
    targetCtr: 0.053,
    impressions90d: 911138,
    measuredCtr: 0.0663,
    measuredPosition: 8.61,
    measuredOn: '2026-08-11',
  },
  {
    // Flagged unregistered by discoverUnregisteredFamilies (issue #6306):
    // 96.180 impressioni/90gg, above MIN_IMPRESSIONS_TO_MONITOR. Verified
    // (2026-08-23) it is NOT a single template: `/vita-in-ticino/` groups 5
    // editorially distinct, hand-authored pages — outlet-svizzera-fox-town-
    // mendrisio, ponti-2026-ticino, vacanze-scolastiche-ticino-2026,
    // lavoro-a-lugano, oss-svizzera — each with its own bespoke title/meta in
    // `build-plugins/editorialContent.ts`, not generated by a shared function
    // the monitor's remediation advice could point at. Registered so future
    // discovery passes don't re-flag it, exempt from `monitored` for the same
    // reason `de` is (no single actionable generator) — see `kind: 'listing'`
    // field docs above.
    id: 'vita-in-ticino',
    label: 'Vita in Ticino (listing editoriale eterogeneo)',
    pathContains: '/vita-in-ticino/',
    kind: 'listing',
    note: 'Raggruppamento di pagine editoriali indipendenti (Fox Town, ponti, calendario scolastico, lavoro a Lugano, OSS Svizzera), ognuna con title/description propri — nessun generator condiviso da poter sorvegliare come famiglia.',
    targetCtr: null,
    monitored: false,
    impressions90d: 96180,
    measuredOn: '2026-08-23',
  },
  {
    // Item 1 of follow-up #5964 (originally deferred from #5962): flagged by
    // discoverUnregisteredFamilies as an unregistered family above
    // MIN_IMPRESSIONS_TO_MONITOR. Confirmed to be the SAME shared
    // canton/aggregator job-board template as `cerca-lavoro-ticino` above
    // (jobsSeoPagesPlugin.ts / jobBoardSeo.ts) — a repeatable generator, not
    // a hand-authored listing like `vita-in-ticino`. Measured live via GSC
    // 2026-05-27 → 2026-08-23 (90d): 101.716 imp, 2.811 click, CTR 2,76%,
    // pos media ponderata 18,27.
    id: 'cerca-lavoro-svizzera',
    label: 'Cerca lavoro Svizzera',
    pathContains: '/cerca-lavoro-svizzera/',
    // EN / DE / FR aggregator slugs (services/router.ts's
    // getAggregatorJobBoardSlug, scripts/lib/section-shard-slugs.json).
    pathAliases: ['/find-jobs-switzerland/', '/jobs-in-schweiz/', '/trouver-emploi-suisse/'],
    kind: 'template',
    monitored: true,
    // Same "own position↔CTR curve" methodology as `cerca-lavoro-ticino`
    // above: at position 18,27 the interpolated benchmark expects 0,973%, so
    // this family already beats its position by 2,84×; target = 80% of that
    // ratio. Il 2,2 di prima veniva dal bucket arrotondato (1,0% a posizione
    // 18) e valeva il 77,6% del CTR misurato invece dell'80% (issue #7412).
    targetCtrCurveMultiple: 2.27,
    // Fallback floor when GSC gives no usable position: 80% of the measured 2,76%.
    targetCtr: 0.022,
    impressions90d: 101716,
    measuredCtr: 0.0276,
    measuredPosition: 18.27,
    measuredOn: '2026-08-25',
  },
  {
    // Item 1 of follow-up #5964: same discovery/verification path as
    // `cerca-lavoro-svizzera` above. Measured live via GSC 2026-05-27 →
    // 2026-08-23 (90d): 104.070 imp, 5.497 click, CTR 5,28%, pos media
    // ponderata 8,22.
    id: 'cerca-lavoro-grigioni',
    label: 'Cerca lavoro Grigioni',
    pathContains: '/cerca-lavoro-grigioni/',
    pathAliases: ['/find-jobs-graubunden/', '/jobs-in-graubunden/', '/trouver-emploi-grisons/'],
    kind: 'template',
    monitored: true,
    // At position 8,22 the interpolated benchmark expects 3,112%, so this
    // family beats its position by 1,70×; target = 80% of that ratio, same
    // methodology as above. Il precedente 1,3 era derivato dal bucket
    // arrotondato (3,2% a posizione 8) e valeva il 76,6% del CTR misurato
    // invece dell'80%: l'allarme pretendeva una regressione del 23,4% per
    // scattare (issue #7412).
    targetCtrCurveMultiple: 1.36,
    targetCtr: 0.042,
    impressions90d: 104070,
    measuredCtr: 0.0528,
    measuredPosition: 8.22,
    measuredOn: '2026-08-25',
  },
  {
    // Same shared canton job-board template as `cerca-lavoro-ticino` /
    // `cerca-lavoro-svizzera` / `cerca-lavoro-grigioni` above
    // (`getJobBoardSlugForCanton` in services/router.ts, canton ZH in
    // data/canton-url-slugs.json), but the `/cerca-lavoro-zurigo/` (IT),
    // `/find-jobs-zurich/` (EN) and `/jobs-in-zurich/` (DE) slugs weren't
    // registered here — discoverUnregisteredFamilies flagged them as 3
    // separate unregistered families instead of 1 (issue #7172, thread
    // #6704). Measured live via GSC 2026-06-05 → 2026-09-03 (90d): 138.210
    // imp, 6.915 click, CTR 5,00%, pos media ponderata 10,64.
    id: 'cerca-lavoro-zurigo',
    label: 'Cerca lavoro Zurigo',
    pathContains: '/cerca-lavoro-zurigo/',
    pathAliases: ['/find-jobs-zurich/', '/jobs-in-zurich/', '/trouver-emploi-zurich/'],
    kind: 'template',
    monitored: true,
    // Same "own position↔CTR curve" methodology as the sibling cantons
    // above: at position 10,64 the interpolated benchmark expects 2,308%, so
    // this family already beats its position by 2,17×; target = 80% of that
    // ratio. Il precedente 1,8 usava il bucket arrotondato (2,2% a posizione
    // 11) e valeva l'83,1% del CTR misurato invece dell'80% (issue #7412).
    targetCtrCurveMultiple: 1.73,
    // Fallback floor when GSC gives no usable position: 80% of the measured 5,00%.
    targetCtr: 0.04,
    impressions90d: 138210,
    measuredCtr: 0.05,
    measuredPosition: 10.64,
    measuredOn: '2026-09-03',
  },
  {
    // Same shared canton job-board template as `cerca-lavoro-ticino` /
    // `cerca-lavoro-svizzera` / `cerca-lavoro-grigioni` / `cerca-lavoro-zurigo`
    // above (`getJobBoardSlugForCanton` in services/router.ts, canton VS in
    // data/canton-url-slugs.json), but unregistered — the FR slug alone had
    // already crossed MIN_IMPRESSIONS_TO_MONITOR and was flagged by
    // discoverUnregisteredFamilies (issue #7173, thread #6704/#7170).
    // Measured live via GSC 2026-06-03 → 2026-09-01 (90d): 142.773 imp,
    // 6.906 click, CTR 4,84%, pos media ponderata 8,51.
    id: 'cerca-lavoro-vallese',
    label: 'Cerca lavoro Vallese',
    pathContains: '/cerca-lavoro-vallese/',
    pathAliases: ['/find-jobs-valais/', '/jobs-im-wallis/', '/trouver-emploi-valais/'],
    kind: 'template',
    monitored: true,
    // Same "own position↔CTR curve" methodology as the sibling cantons
    // above: at position 8,51 the interpolated benchmark expects 2,996%, so
    // this family already beats its position by 1,62×; target = 80% of that
    // ratio. Il precedente 1,4 usava il bucket arrotondato (2,8% a posizione
    // 9): era il caso peggiore del registro, un floor all'86,7% del CTR
    // misurato, cioe` un allarme che scattava gia` a una regressione del
    // 13,3% invece che del 20% (issue #7412).
    targetCtrCurveMultiple: 1.29,
    // Fallback floor when GSC gives no usable position: 80% of the measured 4,84%.
    targetCtr: 0.039,
    impressions90d: 142773,
    measuredCtr: 0.0484,
    measuredPosition: 8.51,
    measuredOn: '2026-09-03',
  },
  {
    // Il template fuel-price giornaliero (`build-plugins/fuelDailyPagesPlugin.ts`
    // + `fuelDailyData.ts`, sezione `FUEL_SECTION_SLUG.benzina`): un generator
    // condiviso di title/description, quindi una famiglia sorvegliabile come le
    // job-board sopra, non un listing editoriale come `vita-in-ticino`. Non era
    // censita, cosi` `discoverUnregisteredFamilies` rialzava lo slug IT e quello
    // EN come DUE famiglie separate sopra soglia (issue #6704, thread #7170).
    // Misurata live via GSC 90gg (finestra chiusa il 2026-09-05) passando a
    // `fetchGscByPage` ESATTAMENTE i quattro prefissi che `familyPathPrefixes()`
    // costruisce qui sotto: 139.514 imp (71.157 IT + 49.367 EN + 14.762 DE +
    // 4.228 FR), 1.710 click, CTR 1,226%, posizione media ponderata 7,46.
    // POPOLAZIONE MISURATA = POPOLAZIONE MONITORATA (issue #7412 item 2). Il
    // dubbio era che `pathContains` sia una substring, quindi che il campione
    // su cui i due target sono tarati escludesse gli archivi mensili
    // `/prezzi-benzina/<zona>/YYYY-MM/` che invece il monitor aggrega. La
    // misura ripetuta con gli stessi prefissi scompone le 139.514 imp in:
    // pagine "oggi" 118.055 (84,6%), per-stazione 16.941 (12,1%), indici di
    // stazione 4.134 (3,0%), archivi mensili 384 (0,28%). Escludere gli
    // archivi porta il CTR da 1,226% a 1,225% e lascia la posizione a 7,46:
    // non diluiscono nulla di misurabile, quindi nessun prefisso da
    // restringere. Il test `familyPathPrefixes copre l'INTERA famiglia fuel`
    // in tests/seo-ctr-curve.test.ts pinna questa identita` per il futuro.
    id: 'prezzi-benzina',
    label: 'Prezzi benzina',
    pathContains: '/prezzi-benzina/',
    // EN / DE / FR: `FUEL_SECTION_SLUG[locale].benzina` in
    // build-plugins/fuelDailyData.ts — stessa forma (a) degli alias job-board,
    // il prefisso di locale c'e` ma il segmento e` tradotto.
    pathAliases: ['/gasoline-price-switzerland/', '/benzinpreis-schweiz/', '/prix-essence-suisse/'],
    kind: 'template',
    monitored: true,
    // Stessa metodologia "curva propria" delle famiglie sopra, con un segno
    // opposto da annotare: a posizione 7,46 il benchmark generico attende
    // 3,469% (valore INTERPOLATO — il 3,7% citato prima era il bucket
    // arrotondato che #7426 ha sostituito) e questa famiglia rende 1,226%,
    // cioe` 0,353× la sua posizione — SOTTO la curva, non sopra come le
    // job-board. Il target resta pero` 80% del
    // rapporto dimostrato (0,8 × 0,353 → 0,283), perche` questo monitor chiede
    // "lo snippet sta ancora rendendo quanto rendeva", ed e` l'unica domanda a
    // cui il suo consiglio di rimedio (generator di title/description) sa
    // rispondere: un target fissato sulla curva generica (3,47%) scatterebbe a
    // ogni run dal primo giorno, e un allarme sempre acceso non e` un allarme.
    // Il divario 0,353× resta visibile lo stesso, nel breakdown belowCurvePages
    // di aggregateFamilyRows, che e` dove va letto.
    targetCtrCurveMultiple: 0.283,
    // Floor assoluto quando GSC non da` una posizione usabile: 80% dell'1,226%
    // misurato, la stessa soglia di regressione ~20% espressa in assoluto.
    targetCtr: 0.0098,
    impressions90d: 139514,
    measuredCtr: 0.01226,
    measuredPosition: 7.46,
    measuredOn: '2026-09-05',
  },
  {
    // Il gemello diesel dello stesso generator fuel (`FUEL_SECTION_SLUG.diesel`).
    // NON era stato rialzato da `discoverUnregisteredFamilies` — e non perche`
    // sia sotto soglia, ma perche` la scoperta somma per SEGMENTO e nessuno dei
    // quattro slug di locale supera 50.000 da solo (39.017 IT il piu` alto). La
    // FAMIGLIA invece li supera: misurata live via GSC 90gg (finestra chiusa il
    // 2026-09-05) con gli stessi quattro prefissi di `familyPathPrefixes()`,
    // 85.934 imp (38.844 IT + 27.123 EN + 16.878 DE + 3.089 FR),
    // 891 click, CTR 1,037%, posizione media ponderata 7,04. Registrarla qui
    // insieme a `prezzi-benzina` e` il fix della CLASSE, non di una istanza
    // (AGENTS.md #6): lasciarla fuori la terrebbe invisibile al monitor finche`
    // un singolo slug non cresce abbastanza da farsi notare.
    // Stessa verifica di popolazione del gemello benzina (issue #7412 item 2):
    // pagine "oggi" 69.202 (80,5%), per-stazione 11.777 (13,7%), indici di
    // stazione 4.723 (5,5%), archivi mensili 232 (0,27%). Senza archivi il CTR
    // passa da 1,037% a 1,036% e la posizione resta 7,04 — nessuna diluizione,
    // il prefisso resta quello.
    id: 'prezzi-diesel',
    label: 'Prezzi diesel',
    pathContains: '/prezzi-diesel/',
    pathAliases: ['/diesel-price-switzerland/', '/dieselpreis-schweiz/', '/prix-gasoil-suisse/'],
    kind: 'template',
    monitored: true,
    // Stessa lettura di `prezzi-benzina` sopra: a posizione 7,04 il benchmark
    // interpolato attende 3,679% e la famiglia rende 1,037%, cioe` 0,282× la
    // sua posizione. Target = 80% del rapporto dimostrato (0,8 × 0,282 → 0,225).
    targetCtrCurveMultiple: 0.225,
    // Floor assoluto senza posizione usabile: 80% dell'1,037% misurato.
    targetCtr: 0.0083,
    impressions90d: 85934,
    measuredCtr: 0.01037,
    measuredPosition: 7.04,
    measuredOn: '2026-09-05',
  },
  {
    id: 'de',
    label: 'DE locale (riferimento)',
    pathContains: '/de/',
    // Locale prefix, not a template: `/de/` aggregates the German variant of
    // every family at once, so a CTR reading here cannot be attributed to any
    // single description generator and the issue the monitor would open would
    // have no actionable path. Report-only by construction.
    kind: 'locale',
    targetCtr: null,
    monitored: false,
    // GSC 2026-05-13 → 2026-08-08: 518.608 imp, 18.541 click, CTR 3,58%, pos 12,52.
    impressions90d: 518608,
    measuredOn: '2026-08-11',
  },
];

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Where `scripts/monitor-seo-ctr-by-template.mjs` persists the families it
 * auto-classified (issue #7174).
 *
 * Why a JSON side-file and not a rewrite of the array above: the monitor runs
 * in CI and its only committed output is what the workflow's `git add` names.
 * A registration that edits this module's source would either be thrown away
 * with the runner (the workflow commits data files, not sources) or — if it
 * were committed — codegen into a hand-written registry whose entries carry
 * the measured GSC numbers in prose comments. A data file keeps the generated
 * half generated, the reviewed half reviewed, and cannot corrupt the module
 * that every consumer imports.
 *
 * Lives next to this module rather than under `data/` so agent sparse
 * checkouts (which exclude `/data/`) can still read and commit it.
 */
export const AUTO_FAMILIES_PATH = resolve(__dirname, 'seo-ctr-auto-families.json');

/**
 * Read the auto-registered families. Fail-open by design: a missing file is
 * the normal state before the first auto-registration, and a corrupt one must
 * degrade to "no auto families" rather than break every consumer of
 * SEO_CTR_FAMILIES (the weekly monitor, seo-ctr-baseline, campaign-goal-check).
 *
 * @param {string} [path] registry file to read.
 * @returns {Array<Record<string, any>>} auto-registered families, `[]` when unreadable.
 */
export function loadAutoRegisteredFamilies(path = AUTO_FAMILIES_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f) => f && typeof f.pathContains === 'string' && typeof f.id === 'string');
  } catch {
    return [];
  }
}

/**
 * Manual registry + auto-registered families, with the manual half winning.
 *
 * An auto entry is dropped when ANY of its `familyPathPrefixes()` is already
 * claimed manually: a human who registered `/cerca-lavoro-zurigo/` with its
 * three locale aliases must not be shadowed by an older auto entry that knew
 * only one of those slugs, and the same prefix must never be counted twice.
 *
 * @param {Array<Record<string, any>>} [manual] hand-curated registry.
 * @param {Array<Record<string, any>>} [auto] auto-registered families.
 * @returns {Array<Record<string, any>>} merged registry.
 */
/**
 * The manual-registry prefixes an auto-classified family would collide with —
 * `[]` when it can be registered.
 *
 * THE AUTHORITY ON COLLISIONS, SHARED WITH THE WRITER. `mergeRegisteredFamilies`
 * below silently drops any auto entry colliding with a hand-curated prefix,
 * which is right on the read side and disastrous on the write side: the weekly
 * monitor built its `claimed` set from the AUTO registry only, so a colliding
 * entry was written to disk, dropped at the next import, and — being present —
 * never retried. The segment stayed out of `SEO_CTR_FAMILIES` forever with no
 * signal at all (#7387). Asking one function means the writer cannot disagree
 * with the reader about what "already claimed" means; a test pins the two
 * together rather than trusting them to stay in step.
 *
 * Typical shape of a real collision: discovery finds the EN slug
 * `/find-jobs-valais/`, the resolver canonicalises it onto the IT
 * `/cerca-lavoro-vallese/` which a human already registered WITHOUT that alias.
 * Silently dropping the entry leaves the EN slug unmonitored; the caller turns
 * a non-empty return into the human-triage issue instead.
 *
 * @param {Record<string, any>} family auto-classified candidate.
 * @param {Array<Record<string, any>>} [manual] hand-curated registry.
 * @returns {string[]} colliding prefixes, empty when the entry is registrable.
 */
export function shadowingManualPrefixes(family, manual = MANUAL_SEO_CTR_FAMILIES) {
  const prefixes = familyPathPrefixes(family);
  return manual.flatMap((f) => familyPathPrefixes(f)).filter((p) => prefixes.includes(p));
}

export function mergeRegisteredFamilies(manual = MANUAL_SEO_CTR_FAMILIES, auto = loadAutoRegisteredFamilies()) {
  const claimed = new Set(manual.flatMap((f) => familyPathPrefixes(f)));
  const extra = [];
  for (const family of auto) {
    const prefixes = familyPathPrefixes(family);
    if (prefixes.some((p) => claimed.has(p))) continue;
    prefixes.forEach((p) => claimed.add(p));
    extra.push(family);
  }
  return [...manual, ...extra];
}

/**
 * The registry every consumer reads: hand-curated families first, then the
 * ones discovery classified on its own. Same shape either way — callers can't
 * tell (and must not care) which half an entry came from.
 */
export const SEO_CTR_FAMILIES = mergeRegisteredFamilies();


/**
 * The CTR floor a family is actually judged against on a given run.
 *
 * When the family declares `targetCtrCurveMultiple` AND the run produced a
 * usable weighted average position, the floor is derived from the position
 * curve — `multiple × expectedCtrForPosition(avgPosition)` — so the threshold
 * follows the family instead of being a number frozen in a file. Otherwise the
 * static `targetCtr` is used, which is what the three #4300 families still do.
 *
 * Shared by scripts/monitor-seo-ctr-by-template.mjs and
 * scripts/seo-ctr-baseline.mjs for the same sibling-pattern reason the curve
 * itself is shared: the two call sites must not disagree on what "below
 * target" means.
 *
 * Returns null when the family has no target at all (report-only families).
 */
export function effectiveTargetCtr(family, avgPosition) {
  if (!family) return null;
  const multiple = Number(family.targetCtrCurveMultiple);
  const position = Number(avgPosition);
  if (Number.isFinite(multiple) && multiple > 0 && Number.isFinite(position) && position >= 1) {
    const expected = expectedCtrForPosition(position);
    if (expected) return multiple * expected;
  }
  return family.targetCtr ?? null;
}

/**
 * All `pathContains`-style substrings a family is known under —
 * `pathContains` plus any `pathAliases` (locale-slug variants of the same
 * template, see the SEO_CTR_FAMILIES field docs above). Shared by
 * `discoverUnregisteredFamilies` (so an aliased locale slug isn't
 * re-flagged as a new family) and by the GSC fetch call sites
 * (scripts/monitor-seo-ctr-by-template.mjs, scripts/seo-ctr-baseline.mjs),
 * which pass the array straight to `fetchGscByPage({ pathContains })` to
 * measure every locale of the family, not just the Italian slug.
 */
export function familyPathPrefixes(family) {
  return [family?.pathContains, ...(family?.pathAliases || [])].filter(Boolean);
}

// Locale prefixes stripped before segmenting a path into a candidate family,
// same set the `locale`-kind exemption in SEO_CTR_FAMILIES is pinned to
// (`/en/`, `/de/`, `/fr/` — Italian has no prefix, it's the default locale).
const LOCALE_PATH_PREFIXES = new Set(['en', 'de', 'fr']);
const ROUTER_LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * Normalize a route segment for classification, independent from GSC-style path
 * formatting (trailing slash, locale-prefixed URLs already stripped).
 */
function normalizeSegmentFromPathContains(pathContains) {
  if (!pathContains || typeof pathContains !== 'string') return '';
  const trimmed = pathContains.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed.slice(1).replace(/\/$/, '') : trimmed.replace(/\/$/, '');
}

/**
 * Build a human-readable label for an auto-registered template family.
 */
function toTitleCase(input) {
  return String(input || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))];
}

function isLocaleRootSegment(segment) {
  return LOCALE_PATH_PREFIXES.has(segment);
}

/**
 * Canonicalise on the Italian slug, exactly like the hand-written entries.
 *
 * Whichever locale slug happens to cross MIN_IMPRESSIONS_TO_MONITOR first is an
 * accident of traffic, not an identity: `/find-jobs-valais/` and
 * `/cerca-lavoro-vallese/` are one family. Registering under the IT slug with
 * the other three as `pathAliases` makes an auto entry indistinguishable from a
 * manual one (`cerca-lavoro-zurigo`, `cerca-lavoro-vallese`), so the dedup in
 * `mergeRegisteredFamilies` can actually see the collision.
 */
/**
 * Build the `pathContains` / `pathAliases` pair of an auto-registered family
 * from a locale→slug lookup, refusing to interpolate a missing slug.
 *
 * THE ONE PLACE A SLUG BECOMES A PATH. Both resolvers below (job-board and
 * fuel) used to interpolate their lookups straight into a template literal, so
 * a locale or a fuel type present on one side of the map and absent on the
 * other produced the literal string `/undefined/`. That entry is not a crash:
 * it is written to `seo-ctr-auto-families.json`, matches no URL ever, and the
 * segment then counts as "registered" while producing zero data forever —
 * exactly the silent blind spot the discovery pass exists to close (#7388).
 *
 * Today `ROUTER_LOCALES` and the slug maps agree, so the defect is latent; it
 * arms itself the first time a new fuel type or a new router locale is added on
 * one side only. Hence the guard lives HERE and not at either call site: a
 * third resolver added tomorrow inherits it by construction.
 *
 * Contract, deliberately asymmetric between the two halves:
 *   - the IT canonical is the family's IDENTITY — missing it means the family
 *     cannot be named at all, so we THROW rather than register a broken entry.
 *     The caller in scripts/monitor-seo-ctr-by-template.mjs turns the throw
 *     into the human-triage issue that `reportUnregisteredFamily` already opens.
 *   - a missing non-IT alias only means one locale is not covered yet, which
 *     the family survives; those are FILTERED OUT, never interpolated.
 *
 * @param {(locale: string) => string|undefined} slugFor lookup, one locale in.
 * @param {string} what human-readable subject, quoted in the error message.
 * @returns {{ canonical: string, pathContains: string, pathAliases: string[] }}
 */
function familyPathsFromSlugLookup(slugFor, what) {
  const canonical = slugFor('it');
  if (typeof canonical !== 'string' || !canonical.trim()) {
    throw new Error(
      `seo-ctr-curve: slug IT mancante per ${what} (ricevuto ${JSON.stringify(canonical)}) — `
      + 'registrare la famiglia produrrebbe un pathContains "/undefined/" che non matcha nessuna URL',
    );
  }
  const pathAliases = uniqueSorted(
    ROUTER_LOCALES
      .filter((l) => l !== 'it')
      .map((l) => slugFor(l))
      .filter((slug) => typeof slug === 'string' && slug.trim())
      .map((slug) => `/${slug}/`),
  ).filter((alias) => alias !== `/${canonical}/`);
  return { canonical, pathContains: `/${canonical}/`, pathAliases };
}

/**
 * Exported for tests only: the guard above is the invariant, and a test that
 * re-implemented it would pin prose instead of behaviour.
 */
export const __familyPathsFromSlugLookup = familyPathsFromSlugLookup;

function resolveJobBoardFamilyFromSegment(segment) {
  for (const locale of ROUTER_LOCALES) {
    const match = parseJobBoardSlug(segment, locale);
    if (!match) continue;

    const { cantonCode, isAggregator } = match;
    const slugFor = (l) => (isAggregator ? getAggregatorJobBoardSlug(l) : getJobBoardSlugForCanton(cantonCode, l));
    const { canonical, pathContains, pathAliases } = familyPathsFromSlugLookup(
      slugFor,
      isAggregator ? 'job board aggregatore' : `job board cantonCode=${cantonCode}`,
    );
    return {
      pathContains,
      pathAliases,
      id: canonical,
      label: `Cerca lavoro ${toTitleCase(canonical.replace(/^cerca-lavoro-/, ''))}`,
      kind: 'template',
      targetCtr: 0.03,
      monitored: true,
      note: `Auto-registrata da discovery template job-board (${isAggregator ? 'aggregatore' : `cantonCode=${cantonCode}`}), scoperta via /${segment}/.`,
    };
  }
  return null;
}

/** Same IT-canonical rule as the job-board resolver above. */
function resolveFuelFamilyFromSegment(segment) {
  let fuel = null;
  for (const locale of ROUTER_LOCALES) {
    const candidateMap = FUEL_SECTION_SLUG[locale];
    if (!candidateMap) continue;
    for (const [fuelType, slug] of Object.entries(candidateMap)) {
      if (slug === segment) {
        fuel = fuelType;
        break;
      }
    }
    if (fuel) break;
  }
  if (!fuel) return null;

  const { canonical, pathContains, pathAliases } = familyPathsFromSlugLookup(
    (l) => FUEL_SECTION_SLUG[l]?.[fuel],
    `sezione carburante fuel=${fuel}`,
  );
  return {
    pathContains,
    pathAliases,
    id: canonical,
    label: `Prezzi ${fuel === 'diesel' ? 'diesel' : 'benzina'}`,
    kind: 'template',
    targetCtr: 0.03,
    monitored: true,
    note: `Auto-registrata da discovery template fuel (${fuel}), scoperta via /${segment}/.`,
  };
}

function resolveLocaleFamilyFromSegment(segment) {
  return {
    pathContains: `/${segment}/`,
    id: segment,
    label: `${segment.toUpperCase()} locale (riferimento)`,
    kind: 'locale',
    targetCtr: null,
    monitored: false,
  };
}

/**
 * Classify a discovered candidate into a registry-like family when the top segment
 * maps to a known generator family. Returns:
 * - `kind: 'locale'` for `/en|de|fr/`
 * - `kind: 'template'` for known job-board and fuel sections
 * - `kind: 'unknown'` otherwise.
 *
 * This classifier is intentionally conservative: only deterministic mappings with
 * explicit generator knowledge are auto-registered.
 */
export function classifyUnregisteredFamilyCandidate({ pathContains, impressions90d } = {}) {
  const segment = normalizeSegmentFromPathContains(pathContains);
  const impressions = Number(impressions90d) || 0;
  if (!segment) return { pathContains: pathContains || '', impressions90d: impressions, kind: 'unknown', family: null };

  if (isLocaleRootSegment(segment)) {
    return {
      pathContains: `/${segment}/`,
      impressions90d: impressions,
      kind: 'locale',
      family: {
        ...resolveLocaleFamilyFromSegment(segment),
        impressions90d: impressions,
        measuredOn: new Date().toISOString().slice(0, 10),
      },
    };
  }

  const jobBoardFamily = resolveJobBoardFamilyFromSegment(segment);
  if (jobBoardFamily) {
    return {
      pathContains: `/${segment}/`,
      impressions90d: impressions,
      kind: jobBoardFamily.kind,
      family: {
        ...jobBoardFamily,
        impressions90d: impressions,
        measuredOn: new Date().toISOString().slice(0, 10),
      },
    };
  }

  const fuelFamily = resolveFuelFamilyFromSegment(segment);
  if (fuelFamily) {
    return {
      pathContains: `/${segment}/`,
      impressions90d: impressions,
      kind: fuelFamily.kind,
      family: {
        ...fuelFamily,
        impressions90d: impressions,
        measuredOn: new Date().toISOString().slice(0, 10),
      },
    };
  }

  return { pathContains: `/${segment}/`, impressions90d: impressions, kind: 'unknown', family: null };
}

/**
 * Discover path segments carrying MIN_IMPRESSIONS_TO_MONITOR+ impressions
 * that aren't covered by any `pathContains` already in the registry —
 * the automated version of what issue #4300 did by hand for
 * `/cerca-lavoro-ticino/` (911k impressions/90gg, invisible to the monitor
 * for years). Pure function: takes raw GSC page rows in, returns candidates
 * out, no I/O — the GSC fetch + issue-opening side effects live in
 * scripts/monitor-seo-ctr-by-template.mjs.
 *
 * `pageRows` — [{ path, impressions }], one entry per indexed page (locale
 * prefix included, e.g. `/en/cerca-lavoro-ticino/some-slug/`). A page's
 * impressions roll up into the segment right after its locale prefix (if
 * any), mirroring how the registry's substring `pathContains` already
 * aggregates every locale of a template into one family.
 */
export function discoverUnregisteredFamilies(pageRows, {
  families = SEO_CTR_FAMILIES,
  minImpressions = MIN_IMPRESSIONS_TO_MONITOR,
} = {}) {
  const registeredPrefixes = new Set(families.flatMap((f) => familyPathPrefixes(f)));
  const bySegment = new Map();

  for (const row of pageRows || []) {
    const path = row?.path;
    if (typeof path !== 'string' || !path) continue;
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    const segment = LOCALE_PATH_PREFIXES.has(parts[0]) ? parts[1] : parts[0];
    if (!segment) continue;
    const prefix = `/${segment}/`;
    if (registeredPrefixes.has(prefix)) continue;
    bySegment.set(prefix, (bySegment.get(prefix) || 0) + Number(row.impressions || 0));
  }

  return [...bySegment.entries()]
    .filter(([, impressions]) => impressions >= minImpressions)
    .map(([pathContains, impressions90d]) => ({ pathContains, impressions90d }))
    .sort((a, b) => b.impressions90d - a.impressions90d);
}

/**
 * Aggregate a list of GSC page rows ({clicks, impressions, ctr, position})
 * into family-level weighted metrics + a below-curve-page breakdown.
 * `underperformRatio` (default 0.6) flags pages whose actual CTR is below
 * that fraction of the position-expected CTR.
 */
export function aggregateFamilyRows(rows, { underperformRatio = 0.6, minImpressions = 20 } = {}) {
  const eligible = rows.filter((r) => Number(r.impressions || 0) >= minImpressions);
  const totalClicks = eligible.reduce((sum, r) => sum + Number(r.clicks || 0), 0);
  const totalImpressions = eligible.reduce((sum, r) => sum + Number(r.impressions || 0), 0);
  const weightedPositionSum = eligible.reduce((sum, r) => sum + Number(r.position || 0) * Number(r.impressions || 0), 0);
  const weightedPosition = totalImpressions > 0
    ? weightedAveragePosition(weightedPositionSum, totalImpressions)
    : null;
  const avgCtr = totalImpressions > 0 ? computeCtr(totalClicks, totalImpressions) : null;

  const belowCurve = eligible
    .map((r) => ({
      ...r,
      expectedCtr: expectedCtrForPosition(r.position),
      gapRatio: ctrGapRatio(r.ctr, r.position),
    }))
    .filter((r) => r.gapRatio !== null && r.gapRatio < underperformRatio)
    .sort((a, b) => Number(b.impressions || 0) - Number(a.impressions || 0));

  return {
    pageCount: eligible.length,
    totalClicks,
    totalImpressions,
    avgCtr,
    avgPosition: weightedPosition,
    belowCurveCount: belowCurve.length,
    belowCurvePages: belowCurve,
  };
}
