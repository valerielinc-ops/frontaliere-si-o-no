/**
 * «Altre aziende da seguire» — the fase 3 recommender on /aziende-seguite/
 * (issue #5012).
 *
 * ── WHAT THIS FILE IS REALLY GUARDING ─────────────────────────────────────
 * The recommender has exactly one runtime input: `/data/employer-job-counts.json`,
 * slug → active postings, ~20 KB, 717 employers at the 2026-08-06 build. Every
 * richer employer attribute the site holds — `sector`, `cantons[]`,
 * `salaryMedianChf`, `trend` — lives in `data/employer-profiles.json` (447 KB),
 * which is BUILD INPUT and is not published; the one published file that
 * carries a per-ad sector and canton is `/data/jobs-<locale>-index.json`, 27,8 MB
 * measured on cdn.frontaliereticino.ch. So the criterion is «the employers
 * hiring most that you do not already follow», re-ranked by a lexical family
 * signal over the slug, and these tests exist to keep it exactly that honest:
 * the family signal must never invent a relationship (stoplist + rarity cap),
 * and the whole thing must collapse to the plain activity order rather than
 * produce something arbitrary when it has nothing to work with.
 *
 * Three properties are load-bearing beyond the ranking itself:
 *
 *   1. NO FETCH. The module is pure. The page already loaded the map for its
 *      per-row «N annunci attivi» line, through the single module-cached reader
 *      in hooks/useEmployerHub.ts. A second fetch here would be a second cache,
 *      a second failure mode and a second thing that can hang the page people
 *      use to UNSUBSCRIBE.
 *   2. THE SLUG SURVIVES THE ROUND TRIP. A card shows a title-cased label and
 *      hands it to CompanyFollowCta; `companyAlertKey` slugifies it back. If
 *      that did not return the slug the card was ranked under, the follow would
 *      be persisted under a token the matcher never sees — the silent-failure
 *      class #5151 removed four copies of.
 *   3. THE TWO SURFACE UNIONS AGREE. `company_follow_suggestion` has to be in
 *      CompanyFollowSurface and in `trackJobAlertCtaClick`, or the surface is
 *      either a type error or unmeasurable.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SUGGESTION_LIMIT,
  FAMILY_TOKEN_MAX_SHARE,
  GENERIC_SLUG_TOKENS,
  MIN_TOKEN_LENGTH,
  rankEmployerSuggestions,
  slugTokens,
} from '@/services/employerSuggestions';
import { companyAlertKey } from '@/services/jobAlertService';
import { MIN_ACTIVE_JOBS } from '../build-plugins/shared/employerProfileConfig.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readRepoFile = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

/**
 * A corpus of the right ORDER OF MAGNITUDE.
 *
 * The rarity cap is a share of the corpus (`FAMILY_TOKEN_MAX_SHARE`), so a
 * ten-entry fixture would make every token look like a family and test nothing
 * that production does. Padding to 100 employers puts the cap at 5, close
 * enough in spirit to the real 35-of-717 that the guards behave the way they
 * will in the browser.
 */
function corpus(entries: Record<string, number>, padTo = 100): Record<string, number> {
  const counts: Record<string, number> = { ...entries };
  for (let i = 0; Object.keys(counts).length < padTo; i += 1) {
    counts[`filler-employer-${i}`] = 6;
  }
  return counts;
}

const slugsOf = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug);

describe('rankEmployerSuggestions — the poor criterion, done honestly', () => {
  it('proposes the most active employers when nothing is followed yet', () => {
    // Cold start, and the moment the block is worth the most: the reader has
    // no follows at all, so there is no affinity to compute and the ONLY
    // defensible order is "who is hiring right now".
    const counts = corpus({ alpha: 40, beta: 90, gamma: 12, delta: 7 });
    expect(slugsOf(rankEmployerSuggestions(counts, [], { limit: 3 })))
      .toEqual(['beta', 'alpha', 'gamma']);
  });

  it('never proposes an employer the user already follows', () => {
    // The whole point of the block. It is also what lets the page skip the
    // per-button Firestore lookup — see `notFollowedByConstruction`.
    const counts = corpus({ alpha: 40, beta: 90, gamma: 12 });
    const out = rankEmployerSuggestions(counts, ['beta'], { limit: 3 });
    expect(slugsOf(out)).not.toContain('beta');
    expect(slugsOf(out)[0]).toBe('alpha');
  });

  it('does not propose an employer below the emitted-page floor', () => {
    // MIN_ACTIVE_JOBS is the floor employerProfilePagesPlugin uses to decide
    // who gets a real `/aziende/<slug>/` page instead of a noindex bridge with
    // no job list. Below it the card would link a page listing nothing while
    // claiming the employer is hiring.
    const counts = corpus({ thin: MIN_ACTIVE_JOBS - 1, thick: MIN_ACTIVE_JOBS });
    const out = rankEmployerSuggestions(counts, [], { limit: 100 });
    expect(slugsOf(out)).toContain('thick');
    expect(slugsOf(out)).not.toContain('thin');
  });

  it('defaults to that floor rather than a number of its own', () => {
    const counts = { only: MIN_ACTIVE_JOBS - 1 };
    expect(rankEmployerSuggestions(counts, [])).toEqual([]);
    expect(rankEmployerSuggestions({ only: MIN_ACTIVE_JOBS }, [])).toHaveLength(1);
  });

  it('orders deterministically, so the block does not reshuffle between renders', () => {
    // JSON object key order is not something to rely on, and a reader who
    // scrolls away and back must find the same five cards in the same places.
    const counts = corpus({ zeta: 20, alpha: 20, mu: 20 });
    const first = slugsOf(rankEmployerSuggestions(counts, [], { limit: 3 }));
    const second = slugsOf(rankEmployerSuggestions({ ...counts }, [], { limit: 3 }));
    expect(first).toEqual(['alpha', 'mu', 'zeta']);
    expect(second).toEqual(first);
  });

  it('honours the limit, and DEFAULT_SUGGESTION_LIMIT is the 3–5 the issue asks for', () => {
    const counts = corpus({ a: 90, b: 80, c: 70, d: 60, e: 50, f: 40 });
    expect(rankEmployerSuggestions(counts, [], { limit: 2 })).toHaveLength(2);
    expect(DEFAULT_SUGGESTION_LIMIT).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_SUGGESTION_LIMIT).toBeLessThanOrEqual(5);
    expect(rankEmployerSuggestions(counts, [])).toHaveLength(DEFAULT_SUGGESTION_LIMIT);
  });
});

describe('the family signal — real on the corpus it was measured against', () => {
  it('puts a shared distinctive token ahead of a busier stranger', () => {
    // Measured shape, not a hypothetical: `klinik` covers 24 of the 717 emitted
    // slugs, so a reader following `hirslanden-klinik` really does have a dozen
    // sibling clinics to be offered before a supermarket chain with more ads.
    const counts = corpus({
      'hirslanden-klinik': 400,
      'berit-klinik': 9,
      'huge-retailer': 900,
    });
    const out = rankEmployerSuggestions(counts, ['hirslanden-klinik'], { limit: 2 });
    expect(slugsOf(out)).toEqual(['berit-klinik', 'huge-retailer']);
    expect(out[0].sharedTokens).toEqual(['klinik']);
    // The second is a plain activity pick and says so — an empty
    // `sharedTokens` is the module admitting it had no reason beyond volume.
    expect(out[1].sharedTokens).toEqual([]);
  });

  it('ranks two shared tokens above one', () => {
    const counts = corpus({
      'ospedale-regionale-lugano': 50,
      'ospedale-civico-lugano': 8,
      'ospedale-di-locarno': 30,
      'clinica-luganese': 40,
    });
    const out = rankEmployerSuggestions(counts, ['ospedale-regionale-lugano'], { limit: 2 });
    expect(slugsOf(out)).toEqual(['ospedale-civico-lugano', 'ospedale-di-locarno']);
    expect(out[0].sharedTokens).toEqual(['lugano', 'ospedale']);
  });

  it('keeps geography as an affinity axis, deliberately', () => {
    // `ticino` is not an industry and is kept anyway: on a site about
    // cross-border commuting, "another employer with a Ticino site" is at least
    // as useful a suggestion as "another employer in the same industry", and
    // the corpus really is full of `…-sede-ticino` slugs.
    const counts = corpus({
      'zurich-insurance-sede-ticino': 600,
      'swisscom-sede-ticino': 20,
      'unrelated-giant': 800,
    });
    const out = rankEmployerSuggestions(counts, ['zurich-insurance-sede-ticino'], { limit: 1 });
    expect(slugsOf(out)).toEqual(['swisscom-sede-ticino']);
    expect(out[0].sharedTokens).toEqual(['ticino']);
  });

  it('does NOT treat a legal form or a country word as a family', () => {
    // `group` (25 slugs), `genossenschaft` (14), `schweiz` (10), `switzerland`
    // (9), `stiftung` (9) all pass the rarity cap comfortably — rarity and
    // meaninglessness are different properties, so the stoplist is a separate
    // guard. Without it, "you follow a Genossenschaft" would connect a
    // supermarket co-op to an electricity co-op.
    const counts = corpus({
      'coop-genossenschaft': 500,
      'raiffeisen-genossenschaft': 8,
      'busier-unrelated': 300,
    });
    const out = rankEmployerSuggestions(counts, ['coop-genossenschaft'], { limit: 2 });
    expect(slugsOf(out)).toEqual(['busier-unrelated', 'raiffeisen-genossenschaft']);
    expect(out.every((row) => row.sharedTokens.length === 0)).toBe(true);
    for (const token of ['group', 'genossenschaft', 'schweiz', 'switzerland', 'stiftung', 'swiss']) {
      expect(GENERIC_SLUG_TOKENS.has(token), `${token} should be stoplisted`).toBe(true);
    }
  });

  it('does NOT treat a token carried by a large share of the corpus as a family', () => {
    // The stoplist can only name words somebody thought of. The cap is the
    // guard for the ones nobody did: at 100 employers it is 5, and a token on
    // eight of them is filler by measurement rather than by opinion.
    const counts: Record<string, number> = { 'common-seed': 500 };
    for (let i = 0; i < 8; i += 1) counts[`common-member-${i}`] = 10;
    counts['busier-unrelated'] = 400;
    const out = rankEmployerSuggestions(corpus(counts), ['common-seed'], { limit: 1 });
    expect(slugsOf(out)).toEqual(['busier-unrelated']);
    expect(FAMILY_TOKEN_MAX_SHARE).toBeLessThanOrEqual(0.1);
  });

  it('ignores tokens too short to mean anything', () => {
    // `ag` is on 151 of the 717 slugs, `sa` on 29, `de` on 24, `la` on 11,
    // `st` on 8. The five most frequent short tokens in the corpus are all
    // noise, which is why the length guard exists at all.
    expect(MIN_TOKEN_LENGTH).toBeGreaterThanOrEqual(3);
    const counts = corpus({ 'meier-ag': 500, 'huber-ag': 9, 'busier-unrelated': 300 });
    const out = rankEmployerSuggestions(counts, ['meier-ag'], { limit: 1 });
    expect(slugsOf(out)).toEqual(['busier-unrelated']);
  });

  it('cannot invent a family out of a token no other employer has', () => {
    // df >= 2 is arithmetic, not taste: a token unique to the followed employer
    // matches nothing, and treating it as a seed would only cost cycles.
    const counts = corpus({ 'unique-name-xyzzy': 500, 'busier-unrelated': 300 });
    const out = rankEmployerSuggestions(counts, ['unique-name-xyzzy'], { limit: 1 });
    expect(out[0].sharedTokens).toEqual([]);
  });

  it('splits the slug and nothing else', () => {
    // The slug is already `canonicalCompanyProfileSlug` output, so `-` is the
    // whole tokenizer. A second normalisation here would be a fifth copy of the
    // one #5151 collapsed into a single module.
    expect(slugTokens('eoc-ente-ospedaliero-cantonale')).toEqual(['eoc', 'ente', 'ospedaliero', 'cantonale']);
    expect(slugTokens('migros')).toEqual(['migros']);
    expect(slugTokens('')).toEqual([]);
  });
});

describe('degrading in silence — the page must never break for a suggestion', () => {
  it('returns nothing while the map is in flight or after a failed fetch', () => {
    // `fetchEmployerHubCounts()` resolves to null in both cases. The section is
    // then not rendered at all: no spinner, no error, no empty box on a page
    // whose actual job is letting people unsubscribe.
    expect(rankEmployerSuggestions(null, [])).toEqual([]);
    expect(rankEmployerSuggestions(undefined, [])).toEqual([]);
  });

  it('returns nothing for an empty or malformed map', () => {
    expect(rankEmployerSuggestions({}, [])).toEqual([]);
    expect(rankEmployerSuggestions({ broken: NaN as unknown as number }, [])).toEqual([]);
    expect(rankEmployerSuggestions({ broken: 'many' as unknown as number }, [])).toEqual([]);
  });

  it('returns nothing when the user already follows everything proposable', () => {
    const counts = { alpha: 40, beta: 90 };
    expect(rankEmployerSuggestions(counts, ['alpha', 'beta'])).toEqual([]);
  });

  it('survives junk in the followed list instead of throwing', () => {
    // `specificCompanyKey` is persisted data. An empty string or a null that
    // slipped through must not take down the page around it.
    const counts = corpus({ alpha: 40 });
    const followed = ['', null as unknown as string, undefined as unknown as string];
    expect(slugsOf(rankEmployerSuggestions(counts, followed, { limit: 1 }))).toEqual(['alpha']);
  });

  it('opens no fetch of its own', () => {
    // The ONE reader of the map is fetchEmployerHubCounts (hooks/useEmployerHub.ts),
    // module-cached and shared with every job surface that links a hub. A second
    // reader here would mean a second cache and a second failure mode for the
    // same 20 KB file.
    const src = readRepoFile('services/employerSuggestions.ts');
    expect(src.includes('fetch(')).toBe(false);
    expect(src.includes('XMLHttpRequest')).toBe(false);
  });
});

describe('the slug the card shows is the slug the follow writes', () => {
  /**
   * Mirror of `companyLabelFromSlug` in FollowedCompaniesPage.tsx.
   *
   * Duplicated rather than imported because the page is a .tsx module that
   * drags React, lucide and half of services/ into a node-environment test for
   * one string transform. The three ingredients the round trip depends on are
   * pinned against the real implementation by the assertion below.
   */
  const labelFromSlug = (slug: string) =>
    slug.split('-').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  it('mirrors the page implementation it stands in for', () => {
    const page = readRepoFile('components/pages/FollowedCompaniesPage.tsx');
    expect(page).toContain('export function companyLabelFromSlug');
    expect(page).toContain(".split('-')");
    expect(page).toContain('.map((w) => w.charAt(0).toUpperCase() + w.slice(1))');
    expect(page).toContain(".join(' ')");
  });

  it('round-trips real employer slugs through the CompanyAlert key', () => {
    // Sampled from data/employer-profiles.json (717 emitted slugs, generatedAt
    // 2026-08-06) to cover what the corpus actually contains: brand folds,
    // legal-form suffixes, accents already stripped, and long multi-word
    // public-sector names. All 717 were verified to round-trip when this was
    // written; these are the shapes worth keeping in CI, without making the
    // suite depend on a 447 KB generated file.
    const realSlugs = [
      'coop-genossenschaft',
      'zurich-insurance-sede-ticino',
      'eoc-ente-ospedaliero-cantonale',
      'hirslanden-klinik',
      'universita-della-svizzera-italiana',
      'migros',
      'stadt-zurich',
      'kanton-aargau',
      'amministrazione-cantonale-ti',
      'abb-svizzera-sede-ticino',
      'agrola-ag',
      '3m-schweiz',
    ];
    for (const slug of realSlugs) {
      // What the card renders → what CompanyFollowCta persists.
      expect(companyAlertKey(labelFromSlug(slug), slug), `${slug} does not round-trip`).toBe(slug);
    }
  });

  it('the card passes the slug as companyKey, not only as a name', () => {
    // `companyAlertKey(name, companyKey)` carries the Lidl special-case on the
    // KEY: dropping it would send every Lidl legal entity to its own alert.
    const page = readRepoFile('components/pages/FollowedCompaniesPage.tsx');
    expect(page).toContain('companyKey={suggestion.slug}');
    expect(page).toContain('company={label}');
  });
});

describe('the page wiring — one button, one fetch, one surface name', () => {
  const page = () => readRepoFile('components/pages/FollowedCompaniesPage.tsx');

  it('feeds the ranker the map the page had already fetched', () => {
    const src = page();
    expect(src).toContain("import { rankEmployerSuggestions } from '@/services/employerSuggestions'");
    // `jobCounts` is the state fed by fetchEmployerHubCounts() — the same map
    // the per-row «N annunci attivi» line reads. No second request.
    expect(src).toContain('fetchEmployerHubCounts()');
    expect(src).toContain('rankEmployerSuggestions(jobCounts, followedSlugs)');
  });

  it('reuses the existing follow CTA instead of drawing a second button', () => {
    const src = page();
    expect(src.split('<CompanyFollowCta').length - 1).toBe(1);
    expect(src).toContain('surface="company_follow_suggestion"');
    // A hand-rolled follow control on this page would bypass the analytics
    // callbacks and the `invalidateUserAlertsCache()` every write owes the
    // other surfaces.
    expect(src.includes('subscribeCompanyAlert')).toBe(false);
  });

  it('renders the block only for a signed-in reader whose list has resolved', () => {
    // Ordering guarantee, not cosmetics: the suggestions can never precede,
    // delay or replace the list this page exists to manage.
    expect(page()).toContain('{user?.uid && alerts !== null && suggestions.length > 0 && (');
  });

  it('shows the block in the empty state too, with copy that does not lie', () => {
    // Following nothing is where the feature is worth the most, and it is also
    // where the ranking has NO affinity input — so the intro changes with it
    // instead of claiming a similarity that was never computed.
    const src = page();
    expect(src).toContain('alerts.length === 0 ? S.suggestIntroCold : S.suggestIntro');
    for (const key of ['suggestTitle', 'suggestIntro', 'suggestIntroCold']) {
      // 4 locales + the PageStrings field.
      expect(src.split(`${key}:`).length - 1, `${key} is not in all four locales`).toBe(5);
    }
  });

  it('skips the per-button alert lookup the page already answered', () => {
    // Five mounted CompanyFollowButtons would otherwise run five uncached
    // getUserAlerts collectionGroup queries for a list sitting in this page's
    // state — and the module-level constant keeps the reference stable, so the
    // button's lookup effect does not re-run and reset a follow the reader just
    // made.
    const src = page();
    expect(src).toContain('const notFollowedByConstruction: typeof findCompanyAlert = async () => null;');
    expect(src).toContain('lookupAlert={notFollowedByConstruction}');
    const cta = readRepoFile('components/community/CompanyFollowCta.tsx');
    expect(cta).toContain('lookupAlert?: typeof findCompanyAlert;');
    // Passed straight through: `undefined` must keep the button's own default.
    expect(cta).toContain('lookup={lookupAlert}');
  });

  it('keeps the two surface unions in step', () => {
    // A name in the component the tracker does not know is a type error; the
    // reverse is a surface nobody reports.
    expect(readRepoFile('components/community/CompanyFollowCta.tsx'))
      .toContain("'company_follow_suggestion'");
    expect(readRepoFile('services/analytics.ts'))
      .toContain("'company_follow_suggestion'");
  });

  it('links the hub only because the floor already proved it exists', () => {
    // An un-emitted `/aziende/<slug>/` is not a recoverable 404 on this site:
    // 404.html → location.replace('/') → SPA restore → staticOverlay → a header
    // and a footer over static HTML that never existed.
    expect(page()).toContain('employerHubPath(suggestion.slug, locale)');
    expect(readRepoFile('services/employerSuggestions.ts')).toContain('MIN_ACTIVE_JOBS');
  });
});

describe('la riga seguita non linka un hub che potrebbe non esistere', () => {
  const page = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'components/pages/FollowedCompaniesPage.tsx'),
    'utf-8',
  );

  it('gate il link "vedi offerte" sulla stessa mappa che prova l\'esistenza', () => {
    // Un datore seguito puo' essere uscito dal corpus dopo il follow: la sua
    // pagina non viene piu' emessa e il link diventa un 404 su una pagina che
    // l'utente apre per DISISCRIVERSI. La regola che il resto della feature
    // applica al conteggio vale identica al link.
    expect(page).toContain("{(jobCounts === null || typeof jobCounts[slug] === 'number') && (");
    expect(page).toContain('href={employerHubPath(slug, locale)}');
  });

  it('mentre la mappa e\' in volo il link resta, invece di sparire a ogni caricamento', () => {
    // `jobCounts === null` copre sia "sto caricando" sia "fetch fallito". Nascondere
    // il link in quello stato sarebbe una regressione peggiore del 404 raro.
    const guard = /jobCounts === null \|\| typeof jobCounts\[slug\] === 'number'/;
    expect(page).toMatch(guard);
  });
});
