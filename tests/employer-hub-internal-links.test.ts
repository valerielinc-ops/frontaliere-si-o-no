/**
 * Internal links into the evergreen employer hubs `/aziende/<slug>/`.
 *
 * ── THE MEASUREMENT THAT MOTIVATES ALL OF THIS ─────────────────────────────
 * GSC, 28 days (9 Jul – 6 Aug 2026, `sc-domain:frontaliereticino.ch`):
 *
 *   · 505 hubs in sitemap-employer-profiles.xml → 571 impressions, 29 clicks,
 *     and only 30 of the 505 got a single impression;
 *   · the brand demand mappable onto those very hubs: 28 826 impressions,
 *     1 257 clicks. A ~50:1 gap;
 *   · «lavorare in / da / presso X»: 629 queries, CTR 10,05 % against the
 *     site's 5,16 %. 115 of the top 200 query→page pairs land on a SINGLE AD
 *     — a page that expires and takes the position with it — and ZERO land on
 *     the hub. «lavorare in eoc» → an ad, position 9.5, 28 impressions, 0
 *     clicks.
 *
 * The hubs are not broken, they are unlinked (monthly impressions
 * 0 / 0 / 47 / 44 / 1 098 / 470). employerProfilePagesLinksPlugin already
 * closed the BFS-orphan half — one link per hub from the 4 HTML sitemap pages,
 * enough for `audit:max-bfs-depth`, worth almost nothing as authority. These
 * tests pin the other half: the surfaces that are ABOUT one employer now link
 * that employer's hub.
 *
 * ── AND THE ONE RULE THAT MAKES IT SAFE ────────────────────────────────────
 * Not every employer has a hub (floors in
 * build-plugins/shared/employerProfileConfig.mjs), and on this site an
 * un-emitted `/aziende/<slug>/` is not a 404 the reader can recover from: it
 * is 404.html → `location.replace('/')` → SPA restore → the router's
 * `^/aziende/<slug>/` branch → `staticOverlay: true` → a header and a footer
 * over static HTML that never existed. Every assertion below about "no link
 * unless proven" is guarding that chain.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  __resetEmployerHubCounts,
  EMPLOYER_JOB_COUNTS_PATH,
  employerHubAnchor,
  employerHubPath,
  employerOpenRolesLabel,
  fetchEmployerHubCounts,
  resolveEmployerHub,
} from '@/hooks/useEmployerHub';
import { companyHubUrl } from '@/services/companyAlertEmail.mjs';
import { canonicalCompanyProfileSlug } from '../build-plugins/shared/companyProfileSlug.mjs';
import { employerTitleCandidates } from '../build-plugins/employerProfilePagesPlugin';
import { BRIDGE_FLOOR, MIN_ACTIVE_JOBS } from '../build-plugins/shared/employerProfileConfig.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readRepoFile = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

describe('the hub URL has one shape, whoever builds it', () => {
  it('IT is unprefixed and every locale uses the same literal `/aziende/` segment', () => {
    expect(employerHubPath('migros', 'it')).toBe('/aziende/migros/');
    expect(employerHubPath('migros', 'en')).toBe('/en/aziende/migros/');
    expect(employerHubPath('migros', 'de')).toBe('/de/aziende/migros/');
    expect(employerHubPath('migros', 'fr')).toBe('/fr/aziende/migros/');
  });

  it('agrees with the email sender, which is a real import and not a source scan', () => {
    // services/companyAlertEmail.mjs builds the ABSOLUTE form of the same URL
    // for the «Vedi tutte le offerte» CTA. Passing an empty base makes the two
    // directly comparable; a divergence here means a follower clicking the
    // email and a reader clicking the site land on different URLs.
    for (const locale of LOCALES) {
      expect(companyHubUrl('eoc-ente-ospedaliero-cantonale', locale, '')).toBe(
        employerHubPath('eoc-ente-ospedaliero-cantonale', locale),
      );
    }
  });

  it('agrees with the emitter, which is the only thing that actually writes the files', () => {
    // build-plugins/employerProfilePagesPlugin.ts owns `profilePath`. It cannot
    // be imported from a runtime module (it is a Vite plugin), so its template
    // is pinned here: if that line changes, this test fails and the runtime
    // half has to move with it.
    const plugin = readRepoFile('build-plugins/employerProfilePagesPlugin.ts');
    expect(plugin).toContain(
      "const localePrefix = (locale: Locale): string => (locale === 'it' ? '' : `/${locale}`);",
    );
    expect(plugin).toContain(
      'const profilePath = (locale: Locale, slug: string): string => `${localePrefix(locale)}/aziende/${slug}/`;',
    );
  });

  it('the followed-companies page uses this builder instead of its own copy', () => {
    // It carried a third hand-rolled copy of the same URL until the fold that
    // landed with this change. Asserting the IMPORT, not the string: a page
    // that builds the path itself is exactly the drift this file exists to
    // prevent, and it would be invisible to a substring check on the output.
    const page = readRepoFile('components/pages/FollowedCompaniesPage.tsx');
    expect(page).toContain("from '@/hooks/useEmployerHub'");
    expect(page).toContain('employerHubPath(slug, locale)');
    expect(page.includes('/aziende/${encodeURIComponent(slug)}/')).toBe(false);
  });

  it('reads the existence map from the path the emitter writes it to', () => {
    expect(EMPLOYER_JOB_COUNTS_PATH).toBe('/data/employer-job-counts.json');
    const plugin = readRepoFile('build-plugins/employerProfilePagesPlugin.ts');
    expect(plugin).toContain("'employer-job-counts.json'");
    expect(plugin).toContain("np.join(distDir, 'data')");
  });
});

describe('resolveEmployerHub — fail-closed on everything it cannot prove', () => {
  const counts = {
    migros: 42,
    'small-employer': BRIDGE_FLOOR, // emitted, but only as a noindex bridge
  };

  it('links an above-floor employer, with the count the last build measured', () => {
    const hub = resolveEmployerHub(counts, 'Migros', undefined, 'it');
    expect(hub).toEqual({ slug: 'migros', href: '/aziende/migros/', activeJobs: 42 });
  });

  it('resolves the slug through the ONE shared normalisation, brand fold included', () => {
    // `canonicalCompanyProfileSlug` folds declared aliases onto the canonical
    // primary; a second slugifier here would send "Migros Ticino" to a URL that
    // was never emitted. Same token CompanyAlert persists (companyAlertKey).
    expect(canonicalCompanyProfileSlug('Migros Ticino')).toBe('migros');
    expect(resolveEmployerHub(counts, 'Migros Ticino', undefined, 'en')?.href).toBe(
      '/en/aziende/migros/',
    );
  });

  it('does NOT link a slug that is absent from the map — that URL has no page', () => {
    // The blank-page chain in this file's header. Absent from the map means
    // employerProfilePagesPlugin emitted nothing at that path, in either band.
    expect(resolveEmployerHub(counts, 'Burkhalter Group', undefined, 'it')).toBeNull();
  });

  it('does NOT link a below-floor employer — the bridge lists no jobs at all', () => {
    // The page exists (noindex,follow bridge at the same URL) so this is not
    // the 404 guard: it is honesty. The CTA promises "all open positions" and
    // the bridge shows none, and a noindex target cannot win the query anyway.
    expect(BRIDGE_FLOOR).toBeLessThan(MIN_ACTIVE_JOBS);
    expect(resolveEmployerHub(counts, 'Small Employer', undefined, 'it')).toBeNull();
  });

  it('does not link while the map is still in flight, or after a failed fetch', () => {
    expect(resolveEmployerHub(null, 'Migros', undefined, 'it')).toBeNull();
  });

  it('does not link an employer with no usable name', () => {
    expect(resolveEmployerHub(counts, '', undefined, 'it')).toBeNull();
    expect(resolveEmployerHub(counts, null, undefined, 'it')).toBeNull();
    expect(resolveEmployerHub(counts, '///', undefined, 'it')).toBeNull();
  });

  it('counts open roles in all four locales, singular included', () => {
    expect(employerOpenRolesLabel(1, 'it')).toBe('1 annuncio attivo');
    expect(employerOpenRolesLabel(7, 'it')).toBe('7 annunci attivi');
    expect(employerOpenRolesLabel(1, 'en')).toBe('1 open role');
    expect(employerOpenRolesLabel(7, 'de')).toBe('7 offene Stellen');
    expect(employerOpenRolesLabel(7, 'fr')).toBe('7 offres actives');
  });
});

describe('fetchEmployerHubCounts — one fetch per session, and a failure is not a state', () => {
  afterEach(() => {
    __resetEmployerHubCounts();
    vi.unstubAllGlobals();
  });

  it('fetches the map once however many surfaces ask for it', async () => {
    // Seven CompanyFollow surfaces already exist and more will link the hub;
    // a per-mount fetch would be seven round-trips for one 20 KB file.
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ migros: 42 }) }));
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([fetchEmployerHubCounts(), fetchEmployerHubCounts()]);
    await fetchEmployerHubCounts();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(EMPLOYER_JOB_COUNTS_PATH);
  });

  it('returns null on a failed fetch and lets the next mount retry', async () => {
    // The map is not decorative here — it is the 404 guard — so a transient
    // failure must neither throw at the caller nor be cached as "no hubs".
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ migros: 42 }) });
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchEmployerHubCounts()).toBeNull();
    expect(await fetchEmployerHubCounts()).toEqual({ migros: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a non-OK response the same way', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await fetchEmployerHubCounts()).toBeNull();
  });
});

describe('every runtime job surface hands the reader to the hub (mossa 1)', () => {
  const CTA = 'components/community/EmployerHubCta.tsx';

  // The three runtime views that are ABOUT one employer: the ad that expired,
  // the slug that never resolved, and — since this change — the ad that is
  // LIVE, where reader intent is highest and the link was missing longest.
  const surfaces = [
    'components/community/JobExpiredView.tsx',
    'components/community/JobOrphanView.tsx',
    'components/community/JobBoard.tsx',
  ];

  it('the CTA exists exactly once, as a component, and owns the whole decision', () => {
    // It used to be a JSX block copy-pasted between two views, identical byte
    // for byte except the expression naming the company. A third copy for the
    // active ad would have made drift a matter of time — and drift here is not
    // cosmetic, since the anchor text is the ranking signal for the DESTINATION
    // and two phrasings split one page's inbound signal in two.
    const src = readRepoFile(CTA);
    expect(src).toContain("from '@/hooks/useEmployerHub'");
    expect(src).toContain('useEmployerHub(');
    expect(src).toContain('if (!employerHub || !company) return null;');
    expect(src).toContain('href={employerHub.href}');
    expect(src).toContain('employerHubAnchor(');
    expect(src).toContain('employerOpenRolesLabel(');
    expect(src).toContain("Analytics.trackSelectContent('employer_hub_open', employerHub.slug)");
    // No `className` / variant prop: a surface that can restyle it is a surface
    // that can diverge, which is the defect the component exists to prevent.
    expect(src).not.toContain('className?:');
  });

  it.each(surfaces)('%s renders the shared CTA instead of its own link', (rel) => {
    const src = readRepoFile(rel);
    expect(src).toContain("from '@/components/community/EmployerHubCta'");
    expect(src).toContain('<EmployerHubCta');
    // And holds no private copy of the machinery: a view that calls the hook
    // itself can render the result any way it likes.
    expect(src).not.toContain('useEmployerHub(');
    expect(src).not.toContain('employerHubAnchor(');
    // No per-view copy map either: two views drifting apart on the same anchor
    // would split one page's inbound signal into two phrases.
    expect(src).not.toContain('HUB_CTA_COPY');
  });

  it.each([CTA, ...surfaces])('%s never builds an /aziende/ URL of its own', (rel) => {
    // The views carry hand-written `slugifyCompanyName` helpers for the
    // job-board FILTER route. None of them may be used to build a hub URL: the
    // only `/aziende/` in these files may be prose in a comment.
    const src = readRepoFile(rel);
    const codeLines = src
      .split('\n')
      .filter((l) => l.includes('/aziende/'))
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(codeLines, `${rel} builds an /aziende/ URL of its own`).toEqual([]);
  });

  it.each(surfaces.slice(0, 2))('%s keeps the company FILTER on a <button>, not an <a href>', (rel) => {
    // The `<a href>` is bought by the existence proof and applies ONLY to the
    // hub. `handleCompanyClick` targets the job-board company filter, which has
    // no such proof: making it an anchor re-opens the burkhalter-group blank
    // page through middle-click / cmd-click / "open in new tab".
    //
    // JobBoard is excluded on purpose: its company control is an `<a>` whose
    // click handler navigates through `openCompanyFilter`, a pre-existing shape
    // this change neither introduced nor touched.
    const src = readRepoFile(rel);
    expect(src).toContain('onClick={handleCompanyClick}');
    expect(src).not.toContain('href={companyHref}');
  });

  it('the ACTIVE ad carries the CTA in BOTH of its layouts, gated and not', () => {
    // JobBoard returns early for `!hasAccess`, so the auth-gate layout is a
    // different subtree from the unlocked detail. The hub is the only useful
    // destination a logged-out reader can reach from the gate WITHOUT signing
    // in, so a single render site would have hidden it from exactly the visitor
    // who arrived from the SERP query the hub is trying to win.
    const src = readRepoFile('components/community/JobBoard.tsx');
    const renders = src.split('<EmployerHubCta').length - 1;
    expect(renders, 'JobBoard must render the hub CTA in the gate AND the detail').toBe(2);
  });

  it('the runtime helper covers all four locales', () => {
    expect(employerHubAnchor('EOC', 'it')).toBe('EOC: offerte di lavoro e stipendi');
    expect(employerHubAnchor('EOC', 'en')).toBe('EOC: jobs and salaries');
    expect(employerHubAnchor('EOC', 'de')).toBe('EOC: offene Stellen und Gehalt');
    expect(employerHubAnchor('EOC', 'fr')).toBe('EOC: offres d’emploi et salaires');
  });

  it('the SSG job page writes the SAME anchor as the runtime views', () => {
    // Two copies remain, and only two: a Vite plugin must not pull a React hook
    // into the build graph, and the hook cannot import the plugin. The BUILD
    // copy is no longer a hardcoded map though — jobsSeoPagesPlugin imports the
    // destination's own `employerTitleCandidates`, so the anchor cannot drift
    // from the <title> it is supposed to reinforce.
    //
    // Compared as rendered STRINGS rather than as source text: that is the
    // property that actually matters, and it survives either side being
    // reformatted.
    const plugin = readRepoFile('build-plugins/jobsSeoPagesPlugin.ts');
    expect(plugin).toContain("import { employerTitleCandidates");
    expect(plugin).toContain('employerTitleCandidates(locale as EmployerProfileLocale, job.company)[0]');

    for (const locale of LOCALES) {
      expect(
        employerTitleCandidates(locale, 'Acme SA')[0],
        `${locale}: build anchor and runtime anchor disagree`,
      ).toBe(employerHubAnchor('Acme SA', locale));
    }
  });

  it('the anchor is the phrase the DESTINATION is trying to win', () => {
    // employerProfilePagesPlugin composes its <title> as
    // `{name}: {INTENT_PHRASE} {AND_WORD} {PAY_PHRASE}` (re-derived from GSC on
    // 2026-08-07: brand-first, "offerte di lavoro" as the head phrase, "e
    // stipendi" as the differentiator vs the canton company hub). Anchor text
    // is a ranking signal for the target, so it mirrors that — asserted on the
    // three maps rather than on the plugin's private helper names, which are
    // that file's business and were rewritten once already.
    const plugin = readRepoFile('build-plugins/employerProfilePagesPlugin.ts');
    expect(plugin).toContain('`${name}: ${INTENT_PHRASE[locale]} ${AND_WORD[locale]} ${PAY_PHRASE[locale]}`');
    expect(plugin).toContain("it: 'offerte di lavoro', en: 'jobs', de: 'offene Stellen', fr: 'offres d’emploi',");
    expect(plugin).toContain("it: 'stipendi', en: 'salaries', de: 'Gehalt', fr: 'salaires',");
  });
});

describe('every active ad links its employer hub (mossa 2)', () => {
  const source = readRepoFile('build-plugins/jobsSeoPagesPlugin.ts');

  it('takes the emitted paths from the build signal, never from an ordering assumption', () => {
    // buildSignals.ts: closeBundle hooks run in PARALLEL. Reading another
    // plugin's output without its explicit barrier is a known recurring bug
    // shape in this repo (PATTERN_CLASSES in scripts/ci/check-sibling-patterns.mjs).
    expect(source).toContain("import { employerProfilesFlushed, resolveJobsSeoPagesFlushed } from './shared/buildSignals';");
    expect(source).toContain('for (const emitted of await employerProfilesFlushed) {');
  });

  it('copies the href out of the emitter instead of rebuilding the URL', () => {
    // The slug is only a lookup KEY. A key that drifts misses the map and
    // produces no link; it can never produce a wrong one.
    expect(source).toContain('const emittedEmployerHubs = new Map<string, string>();');
    expect(source).toContain('emittedEmployerHubs.set(`${m[1] ?? \'it\'}|${m[2]}`, emitted.path);');
    expect(source).toContain('const hubPath = emittedEmployerHubs.get(`${locale}|${cSlugBanner}`);');
    expect(source).toContain('<a href="${esc(hubPath)}">');
    // Not a second `/aziende/` template inside this plugin.
    expect(source).not.toContain('/aziende/${');
  });

  it('emits nothing when the employer has no emitted hub', () => {
    expect(source).toContain('const hubLink = hubPath');
    expect(source).toContain("      : '';");
    expect(source).toContain('return card + ctaLink + hubLink;');
  });

  it('the path regex accepts exactly what employerProfilePagesPlugin writes', () => {
    // Pinned to the literal in the plugin by the assertion below, then executed
    // against the four paths `profilePath(locale, slug)` produces.
    const literal = /^(?:\/(en|de|fr))?\/aziende\/([^/]+)\/$/;
    expect(source).toContain(String(literal));

    const emitted = LOCALES.map((locale) => ({
      locale,
      path: `${locale === 'it' ? '' : `/${locale}`}/aziende/eoc-ente-ospedaliero-cantonale/`,
    }));
    for (const { locale, path } of emitted) {
      const m = literal.exec(path);
      expect(m, `${path} did not parse`).not.toBeNull();
      expect(m![1] ?? 'it').toBe(locale);
      expect(m![2]).toBe('eoc-ente-ospedaliero-cantonale');
    }

    // And rejects the neighbouring namespaces, so a `/lavoro/` or
    // `/aziende-che-assumono/` path can never be keyed in as a hub.
    expect(literal.test('/lavoro/eoc/')).toBe(false);
    expect(literal.test('/aziende-che-assumono/ticino/settimana-corrente/')).toBe(false);
    expect(literal.test('/aziende/eoc/lugano/')).toBe(false);
  });

  it('the anchor does not compete with the canton company hub already linked', () => {
    // The ad already carries "Tutte le offerte {company} {location}" pointing
    // at `/cerca-lavoro-<canton>/azienda-<slug>/` — the sibling that HOLDS this
    // brand demand today. Two links to two DIFFERENT pages must not share a
    // phrase, or they cannibalise each other in the SERP: the canton token
    // differentiates one, the salary token the other.
    expect(source).toContain('it: `Tutte le offerte ${job.company}');
    expect(source).toContain('${companyLoc}'); // the canton/city token on the sibling anchor
    // The hub anchor carries the salary token instead — asserted on the string
    // the build actually renders, since the phrase now comes from the
    // destination plugin rather than a local map.
    expect(employerTitleCandidates('it', 'Acme SA')[0]).toContain('stipendi');
    expect(employerTitleCandidates('it', 'Acme SA')[0]).not.toContain('Tutte le offerte');
  });
});

describe('employerProfilePagesLinksPlugin is not duplicated by any of this', () => {
  it('still owns exactly one job: the sitemap-page block that closes the BFS tier', () => {
    // Different problem, different mechanism: that plugin makes the hubs
    // REACHABLE (depth ≤ 3 from `/`), this change makes them AUTHORITATIVE.
    // If it ever grew a per-job injector too, 36k HTML files would be rewritten
    // post-hoc for links jobsSeoPagesPlugin can emit for free at render time.
    const links = readRepoFile('build-plugins/employerProfilePagesLinksPlugin.ts');
    expect(links).toContain('data-employer-profiles-links');
    expect(links).toContain('SITEMAP_PAGE_DIR[locale]');
    expect(links).not.toContain('jobsSeoPages');
  });
});
