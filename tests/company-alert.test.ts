/**
 * CompanyAlert — issue #5012.
 *
 * The employer pin (`specificCompanyKey`) has been a hard filter in the matcher
 * since day one and was completely inert: every write path passed `null`,
 * `getUserAlerts()` never read it back, `updateAlert()` had no branch for it,
 * and the token-mode Cloud Function rejected a company-only alert with
 * `missing_filters`. These tests pin the round-trip end to end plus the ONE
 * company-slug normalisation the whole feature depends on.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { baseCompanySlug, canonicalCompanyProfileSlug, rawCompanySlug } from '../build-plugins/shared/companyProfileSlug.mjs';
import { canonicalEmployerBrandKey } from '@/services/employerBrands';
import { canonicalCompanySlug } from '../build-plugins/weeklyEmployersData';
import { buildAlertProfile, scoreJobForAlert } from '@/services/jobAlertMatching.mjs';

// Firestore primitives are mocked so the phase-2 write path
// (`subscribeCompanyAlert` → `createAlert`) can be asserted on the document
// body it actually persists, instead of being restated as a source-scan.
// Hoisted by vitest above every import below.
const addDocMock = vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({ id: 'alert-id' }));
const setDocMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const getDocsMock = vi.fn<(...args: unknown[]) => Promise<{ size: number; docs: unknown[] }>>(
  async () => ({ size: 0, docs: [] }),
);
vi.mock('firebase/firestore', () => ({
  collectionGroup: vi.fn(() => ({})),
  collection: vi.fn(() => ({})),
  addDoc: (...args: unknown[]) => addDocMock(...args),
  doc: vi.fn(() => ({})),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  updateDoc: vi.fn(async () => undefined),
  query: vi.fn(() => ({})),
  where: vi.fn(() => ({})),
  getDocs: (...args: unknown[]) => getDocsMock(...args),
  orderBy: vi.fn(() => ({})),
  serverTimestamp: vi.fn(() => new Date()),
  getFirestore: vi.fn(() => ({})),
}));

import { companyAlertKey, MAX_ALERTS_PER_USER, subscribeCompanyAlert } from '@/services/jobAlertService';
import {
  buildCompanyAlertEmail,
  companyHubUrl,
  COMPANY_ALERT_STRINGS,
  COMPANY_ALERT_TEMPLATE_ID,
} from '@/services/companyAlertEmail.mjs';
import { isImmediateCompanyAlert } from '../scripts/lib/company-alert-routing.mjs';
import { companyFollowMountPlaceholder } from '../build-plugins/shared/companyFollowMountPlaceholder';
import { selectNewlyPublishedJobs } from '../scripts/send-company-alerts.mjs';
import {
  flushPendingCompanyFollows,
  pruneExpired,
  readPendingCompanyFollows,
  savePendingCompanyFollow,
  clearPendingCompanyFollows,
  PENDING_FOLLOW_TTL_MS,
} from '@/services/companyFollowIntent';

const repoRoot = path.resolve(__dirname, '..');
const readRepoFile = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf-8');

describe('one company-slug normalisation (#5012, Non-Negotiable #6)', () => {
  const cases: Array<[string, string | undefined]> = [
    ['Board International', undefined],
    ['Migros Ticino', undefined],
    ['Lidl Svizzera', 'lidl-ch'],
    ['Coop Genossenschaft', undefined],
    ['Ente Ospedaliero Cantonale', 'eoc'],
    ['  Bürgenstock  Hotels & Resort ', undefined],
  ];

  it.each(cases)('canonicalEmployerBrandKey delegates to baseCompanySlug for %s', (name, key) => {
    expect(canonicalEmployerBrandKey(name, key)).toBe(baseCompanySlug(name, key));
  });

  it.each(cases)('canonicalCompanySlug delegates to baseCompanySlug for %s', (name, key) => {
    expect(canonicalCompanySlug(name, key)).toBe(baseCompanySlug(name, key));
  });

  it('keeps the historical shape: accents stripped, runs collapsed, Lidl folded', () => {
    expect(baseCompanySlug('Bürgenstock Hotels & Resort')).toBe('burgenstock-hotels-resort');
    expect(baseCompanySlug('Lidl Schweiz AG')).toBe('lidl');
    expect(baseCompanySlug('', 'lidl-ch')).toBe('lidl');
    expect(baseCompanySlug('')).toBe('');
  });

  it('only canonicalCompanyProfileSlug folds brand aliases (the alert key does)', () => {
    expect(baseCompanySlug('Migros Ticino')).toBe('migros-ticino');
    expect(canonicalCompanyProfileSlug('Migros Ticino')).toBe('migros');
  });

  it('no file re-implements the slugify literal any more', () => {
    const literal = "replace(/[^a-z0-9]+/g, ' ')";
    for (const rel of [
      'services/employerBrands.ts',
      'build-plugins/weeklyEmployersData.ts',
      'scripts/refresh-weekly-employers-top-pairs.mjs',
      'services/jobAlertMatching.mjs',
    ]) {
      expect(readRepoFile(rel).includes(literal), `${rel} still re-implements the slugify`).toBe(false);
    }
  });

  it('the Lidl fold lives in exactly one module', () => {
    // Widened after review: the extraction above MISSED two copies —
    // `canonicalCompanySlugBuild` in jobsSeoPagesPlugin.ts, the plugin that emits the
    // indexed /aziende/<slug>/ pages (its own comment called it "Mirror runtime
    // canonicalCompanyRouteSlug logic"), and `canonicalCompanyRouteSlug` in JobBoard.tsx,
    // the very file this feature mounts its CTA in. If either drifts, the hub URL and the
    // token CompanyAlert persists stop agreeing — silently, no error, user convinced they
    // are subscribed. That is the failure this feature exists to prevent.
    //
    // The generic slugify literal is the WRONG fingerprint for these two: both files also
    // contain unrelated text normalisers that share it (jobsSeoPagesPlugin's
    // `normalizeSearchTerm` matches search-landing queries, not company URLs), so asserting
    // on it would fail for a file that is perfectly clean. The Lidl special-case is
    // specific to the company-slug normalisation, so it is the fingerprint that actually
    // means "somebody re-implemented this".
    const fold = "includes('lidl')";
    expect(readRepoFile('build-plugins/shared/companyProfileSlug.mjs').includes(fold)).toBe(true);
    for (const rel of [
      'build-plugins/jobsSeoPagesPlugin.ts',
      'components/community/JobBoard.tsx',
      'services/employerBrands.ts',
      'build-plugins/weeklyEmployersData.ts',
      'scripts/refresh-weekly-employers-top-pairs.mjs',
      'services/jobAlertMatching.mjs',
      // Round 3 of review found three MORE copies. staticPagesPlugin's carried a comment
      // saying it "MUST mirror" the two above — and a production 404 ("burkhalter-group")
      // that a hand-kept mirror had already caused. job-board-stats feeds the
      // topCompaniesActive URLs; TicinoCompanies builds a live CTA href. Every one of them
      // is a funnel-critical URL, which is why the list is exhaustive rather than a sample.
      'build-plugins/staticPagesPlugin.ts',
      'scripts/lib/job-board-stats.mjs',
      'components/vita/TicinoCompanies.tsx',
    ]) {
      expect(readRepoFile(rel).includes(fold), `${rel} re-implements the company-slug Lidl fold`).toBe(false);
    }
  });

  it('the raw (un-folded) slug is shared too, and still differs from the canonical', () => {
    // rawCompanySlug is NOT an internal detail of baseCompanySlug: the router and the hub
    // builder keep it alongside the canonical so already-indexed alias URLs still resolve.
    // Collapsing the two would 404 them, so the distinction is asserted, not assumed.
    expect(rawCompanySlug('Lidl Schweiz AG')).toBe('lidl-schweiz-ag');
    expect(baseCompanySlug('Lidl Schweiz AG')).toBe('lidl');
    expect(rawCompanySlug('Bürgenstock Hotels & Resort')).toBe('burgenstock-hotels-resort');
    expect(rawCompanySlug('')).toBe('');
  });

  it('the migrated build/router copies still agree with the shared function', () => {
    // Behaviour-preservation check for the review fix: the two hand-written copies were
    // byte-equivalent to baseCompanySlug, so delegating must not move a single slug.
    // These are the shapes that actually occur in the crawled corpus.
    for (const [name, key] of [
      ['Coop Genossenschaft', undefined],
      ['Migros Ticino', 'migros-ti'],
      ['Lidl Svizzera DL AG', 'lidl-ch'],
      ['Bürgenstock Hotels & Resort', undefined],
      ['  Ospedale  Regionale   di Lugano ', 'orl'],
      ['', ''],
    ] as const) {
      const expected =
        String(key || '').toLowerCase().includes('lidl') || String(name).toLowerCase().includes('lidl')
          ? 'lidl'
          : String(name)
              .toLowerCase()
              .normalize('NFD')
              .replace(/[̀-ͯ]/g, '')
              .replace(/[^a-z0-9]+/g, ' ')
              .trim()
              .replace(/\s+/g, '-');
      expect(baseCompanySlug(name, key)).toBe(expected);
    }
  });
});

describe('matcher pin still fires with the shared normalisation (#5012)', () => {
  function alertFor(companyKey: string) {
    return buildAlertProfile(
      {
        keywords: [],
        locations: [],
        sectors: [],
        contractTypes: [],
        cantonFilter: null,
        specificCompanyKey: companyKey,
      },
      {},
    );
  }

  it('matches a job of the pinned employer and nothing else', () => {
    const profile = alertFor(canonicalCompanyProfileSlug('Board International'));
    const hit = { id: 'a', title: 'Sviluppatore', company: 'Board International SA', canton: 'TI' };
    const miss = { id: 'b', title: 'Sviluppatore', company: 'Medacta International SA', canton: 'TI' };
    expect(scoreJobForAlert(hit, profile)).toBeGreaterThan(0);
    expect(scoreJobForAlert(miss, profile)).toBe(0);
  });

  it('matches across the Lidl legal-entity variants the slug folds', () => {
    const profile = alertFor(canonicalCompanyProfileSlug('Lidl Svizzera'));
    for (const company of ['Lidl Schweiz AG', 'Lidl Svizzera SA', 'LIDL Suisse']) {
      expect(scoreJobForAlert({ id: 'x', title: 'Venditore', company, canton: 'AG' }, profile)).toBeGreaterThan(0);
    }
  });
});

describe('alert cap parity across the three enforcement points (#5012)', () => {
  it('client, token Cloud Function and backfill agree', () => {
    const cf = readRepoFile('functions/src/newsletterSubscriptionManagement.js');
    const backfill = readRepoFile('functions/src/jobAlertBackfillCore.js');
    const cfCap = Number(/const MAX_ALERTS_PER_USER = (\d+)/.exec(cf)?.[1]);
    const backfillCap = Number(/MAX_ALERTS_PER_USER = (\d+)/.exec(backfill)?.[1]);
    expect(cfCap).toBe(MAX_ALERTS_PER_USER);
    expect(backfillCap).toBe(MAX_ALERTS_PER_USER);
  });
});

describe('token-mode Cloud Function accepts a company-only alert (#5012)', () => {
  const cf = readRepoFile('functions/src/newsletterSubscriptionManagement.js');

  it('does not reject a create with only a company pin', () => {
    expect(cf).toContain('!companyPin && !jobPin');
  });

  it('serializes the pin back to the client', () => {
    expect(cf).toContain('specificCompanyKey: typeof data?.specificCompanyKey');
  });

  it('mirrors baseCompanySlug exactly (bundle cannot import outside functions/)', () => {
    const fn = /function normalizeCompanyAlertKey\(value\) \{[\s\S]*?\n\}/.exec(cf)?.[0] || '';
    expect(fn).toBeTruthy();
    // eslint-disable-next-line no-new-func
    const mirror = new Function(`${fn}; return normalizeCompanyAlertKey;`)() as (v: string) => string;
    for (const name of ['Board International', 'Bürgenstock Hotels & Resort', 'Lidl Schweiz AG', 'Coop', '']) {
      expect(mirror(name)).toBe(baseCompanySlug(name, name));
    }
  });
});

describe('HTTP entrypoint forwards every field the handler accepts (#5012)', () => {
  const index = readRepoFile('functions/index.js');

  it.each(['paused', 'specificCompanyKey', 'specificJobId'])(
    'forwards %s (an accepted-but-never-forwarded field is an inert feature)',
    (field) => {
      expect(index).toContain(`\n ${field},`);
    },
  );
});

describe('pinned-company match survives a brand alias whose canonical is not a substring (#5012 review)', () => {
  // Raised as a question in review. It is a real defect, and it is the precise failure
  // mode this feature was built to avoid: the alert saves fine, the UI says "following",
  // and no email ever arrives.
  //
  // Lidl and Migros hid it. Lidl folds every variant to `lidl` on BOTH sides, and
  // `migros-ticino` happens to CONTAIN `migros`, so the bidirectional substring test
  // passes by luck. Guess has neither property: the alert stores the canonical
  // `guess-europe-sagl`, a job carries `Guess Ticino` -> `guess-ticino`, and neither
  // string contains the other.
  function alertFor(companyKey: string) {
    return buildAlertProfile(
      { keywords: [], locations: [], sectors: [], contractTypes: [], cantonFilter: null, specificCompanyKey: companyKey },
      {},
    );
  }

  it('matches a job posted under a declared alias of the followed brand', () => {
    const pin = canonicalCompanyProfileSlug('Guess Ticino');
    expect(pin).toBe('guess-europe-sagl'); // the alias folded on write

    const profile = alertFor(pin);
    for (const company of ['Guess Ticino', 'Guess Europe Sagl', 'Guess Europe Switzerland']) {
      expect(
        scoreJobForAlert({ id: 'g', title: 'Sales Assistant', company, canton: 'TI' }, profile),
        `following Guess must match a job posted as "${company}"`,
      ).toBeGreaterThan(0);
    }
  });

  it('still refuses an unrelated employer', () => {
    const profile = alertFor(canonicalCompanyProfileSlug('Guess Ticino'));
    expect(scoreJobForAlert({ id: 'x', title: 'Sales Assistant', company: 'Medacta International SA', canton: 'TI' }, profile)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 (#5012): anonymous capture + double opt-in, immediate cadence,
// dedicated `company_alert` template, followed-companies page.
// ─────────────────────────────────────────────────────────────────────────────

describe('immediate cadence — the two senders partition the alerts (#5012 phase 2)', () => {
  const pinned = { specificCompanyKey: 'board-international', frequency: 'immediate' };

  it('claims a company-pinned alert on the immediate cadence', () => {
    expect(isImmediateCompanyAlert(pinned)).toBe(true);
  });

  it('leaves a PRE-phase-2 company alert on the digest', () => {
    // Back-compat, and it is the whole reason the predicate tests the cadence
    // and not just the pin: alerts created by #5151 carry frequency 'daily'.
    // Claiming them here would move a live subscriber onto a new sender without
    // a migration.
    expect(isImmediateCompanyAlert({ specificCompanyKey: 'board-international', frequency: 'daily' })).toBe(false);
  });

  it('never claims an alert without an employer pin', () => {
    // An immediate cadence with no pin would mean one email per job across the
    // whole board. The pin is what bounds the volume.
    expect(isImmediateCompanyAlert({ specificCompanyKey: null, frequency: 'immediate' })).toBe(false);
    expect(isImmediateCompanyAlert({ frequency: 'immediate' })).toBe(false);
  });

  it('respects paused and soft-deleted alerts', () => {
    expect(isImmediateCompanyAlert({ ...pinned, paused: true })).toBe(false);
    expect(isImmediateCompanyAlert({ ...pinned, active: false })).toBe(false);
  });

  it('tolerates junk input instead of throwing mid-run', () => {
    expect(isImmediateCompanyAlert(null as unknown as Record<string, unknown>)).toBe(false);
    expect(isImmediateCompanyAlert(undefined as unknown as Record<string, unknown>)).toBe(false);
  });

  it('the digest applies the NEGATION of the same shared predicate', () => {
    // The partition has to be disjoint AND total, and the only way to guarantee
    // that is one function used on both sides. A hand-written "not a company
    // alert" condition in the digest is how an alert ends up claimed twice (two
    // emails) or by nobody (a silent never-send).
    const digest = readRepoFile('scripts/send-job-alerts.mjs');
    expect(digest).toContain("from './lib/company-alert-routing.mjs'");
    expect(digest).toContain('!isImmediateCompanyAlert(a)');
    // …and it must not re-derive the rule locally.
    expect(digest.includes("a.frequency === 'immediate'")).toBe(false);
  });

  it('the immediate sender uses the digest\'s EXISTING query shape (no new index)', () => {
    // firestore.indexes.json is not applied by CI, so a new `where` clause here
    // would merge green and then throw FAILED_PRECONDITION in production on the
    // first real run. Both senders must issue the identical collectionGroup
    // query and filter in memory.
    const sender = readRepoFile('scripts/send-company-alerts.mjs');
    expect(sender).toContain("collectionGroup('alerts').where('active', '==', true)");
    expect(sender.includes("where('specificCompanyKey'")).toBe(false);
    expect(sender.includes("where('frequency'")).toBe(false);
  });
});

describe('immediate sender novelty window (#5012 phase 2)', () => {
  const now = Date.UTC(2026, 7, 5, 12, 0, 0);
  const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();

  it('selects jobs by firstSeenAt, not crawledAt', () => {
    // crawledAt refreshes on every re-crawl, so keying on it would mail the
    // entire standing inventory on the first run. firstSeenAt is carried
    // forward by assemble-jobs-dataset.mjs and is the genuine novelty signal.
    const jobs = [
      { id: 'new', firstSeenAt: hoursAgo(1), crawledAt: hoursAgo(1) },
      { id: 'old-but-recrawled', firstSeenAt: hoursAgo(72), crawledAt: hoursAgo(1) },
    ];
    expect(selectNewlyPublishedJobs(jobs, now, 6 * 3600_000).map((j) => j.id)).toEqual(['new']);
  });

  it('drops jobs with no firstSeenAt rather than assuming they are new', () => {
    expect(selectNewlyPublishedJobs([{ id: 'x' }, { id: 'y', firstSeenAt: '' }], now, 6 * 3600_000)).toEqual([]);
  });

  it('tolerates an empty/absent dataset', () => {
    expect(selectNewlyPublishedJobs([], now)).toEqual([]);
    expect(selectNewlyPublishedJobs(undefined as unknown as object[], now)).toEqual([]);
  });
});

describe('subscribeCompanyAlert persists the immediate cadence (#5012 phase 2)', () => {
  beforeEach(() => {
    addDocMock.mockClear();
    setDocMock.mockClear();
    getDocsMock.mockClear();
    getDocsMock.mockResolvedValue({ size: 0, docs: [] });
  });

  it('writes frequency:immediate with a sticky override and the canonical key', async () => {
    await subscribeCompanyAlert('user-1', 'Foo@Example.COM', { name: 'Migros Ticino' }, 'it');
    const payload = (addDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      frequency: 'immediate',
      // Sticky: without it the adaptive-cadence engine
      // (scripts/lib/jobAlertEngagementTier.mjs) could demote a followed
      // employer to weekly because the subscriber hasn't opened lately.
      frequencyOverride: true,
      // Brand-alias fold applied on the ONE write path.
      specificCompanyKey: 'migros',
      keywords: [],
      locations: [],
    });
  });
});

describe('company_alert template — the dedicated email the issue asks for (#5012)', () => {
  const job = {
    id: 'j1',
    title: 'Sviluppatore Full Stack',
    company: 'Board International SA',
    location: 'Lugano',
    canton: 'TI',
    url: 'https://frontaliereticino.ch/lavoro/sviluppatore-full-stack/',
  };
  const build = (locale: string, jobs = [job]) => buildCompanyAlertEmail({
    companyName: 'Board International SA',
    companySlug: 'board-international',
    jobs,
    email: 'a@b.ch',
    locale,
    manageUrl: 'https://frontaliereticino.ch/preferenze-newsletter/',
    unsubscribeUrl: 'https://frontaliereticino.ch/disiscrivi-alert/?x=1',
    unsubscribeAllUrl: 'https://frontaliereticino.ch/disiscrivi-alert/?all=1',
  });

  it('subjects read «Nuova offerta presso [Azienda]» and name the employer in all 4 locales', () => {
    // Verbatim from the issue. Before this template the notification went out
    // under the generic job-alert subject ("🔔 <title> presso <company>") whose
    // filter line said «tutte le offerte» — an email that never named what the
    // user had followed.
    expect(build('it').subject).toBe('Nuova offerta presso Board International SA');
    expect(build('en').subject).toBe('New job at Board International SA');
    expect(build('de').subject).toBe('Neue Stelle bei Board International SA');
    expect(build('fr').subject).toBe('Nouvelle offre chez Board International SA');
  });

  it('pluralises honestly on the RENDERED count', () => {
    const jobs = [job, { ...job, id: 'j2', title: 'Data Analyst' }];
    expect(build('it', jobs).subject).toBe('2 nuove offerte presso Board International SA');
  });

  it('carries the «Vedi tutte le offerte di [Azienda]» CTA in html AND text', () => {
    const { html, text } = build('it');
    expect(html).toContain('Vedi tutte le offerte di Board International SA');
    expect(text).toContain('Vedi tutte le offerte di Board International SA');
  });

  it('points that CTA at the real employer hub — ONE `/aziende/` segment per locale', () => {
    // employerProfilePagesPlugin emits /aziende/<slug>/ and /en|/de|/fr/aziende/<slug>/;
    // translating the segment would build a link the site does not serve.
    expect(companyHubUrl('board-international', 'it')).toBe('https://frontaliereticino.ch/aziende/board-international/');
    expect(companyHubUrl('board-international', 'de')).toBe('https://frontaliereticino.ch/de/aziende/board-international/');
    expect(build('fr').html).toContain('/fr/aziende/board-international/');
  });

  it('always renders both unsubscribe links (GDPR + RFC 8058)', () => {
    const { html } = build('it');
    expect(html).toContain('https://frontaliereticino.ch/disiscrivi-alert/?x=1');
    expect(html).toContain('https://frontaliereticino.ch/disiscrivi-alert/?all=1');
  });

  it('escapes employer names so an `&` cannot break the markup', () => {
    const { html } = buildCompanyAlertEmail({
      companyName: 'Bürgenstock Hotels & Resort',
      companySlug: 'burgenstock-hotels-resort',
      jobs: [job],
      email: 'a@b.ch',
      locale: 'it',
      manageUrl: 'https://x/',
      unsubscribeUrl: 'https://x/',
      unsubscribeAllUrl: 'https://x/',
    });
    expect(html).toContain('Hotels &amp; Resort');
    expect(html).not.toContain('Hotels & Resort');
  });

  it('ships all four locales with the same key set — no partial translation', () => {
    // A user-facing surface in one language is incomplete, not "translatable
    // later". Comparing key SETS catches a locale that was added by copy-paste
    // and then diverged.
    const itKeys = Object.keys(COMPANY_ALERT_STRINGS.it).sort();
    for (const loc of ['en', 'de', 'fr'] as const) {
      expect(Object.keys(COMPANY_ALERT_STRINGS[loc]).sort(), `${loc} drifted from it`).toEqual(itKeys);
    }
  });

  it('tags the send as `company_alert`, distinguishable from `job-alert`', () => {
    expect(COMPANY_ALERT_TEMPLATE_ID).toBe('company_alert');
    const sender = readRepoFile('scripts/send-company-alerts.mjs');
    expect(sender).toContain("{ name: 'type', value: COMPANY_ALERT_TEMPLATE_ID }");
  });

  it('the DIGEST also names the pinned employer instead of «tutte le offerte»', () => {
    // A company-pinned alert has no keywords/locations/sectors, so filterLabel
    // fell through to s.allOffers. Pre-phase-2 company alerts still ride the
    // digest, so this branch is not dead code.
    const digest = readRepoFile('scripts/send-job-alerts.mjs');
    expect(digest).toContain('if (alert.specificCompanyKey) {');
    expect(digest).toContain('filterParts.push(pinnedCompanyName);');
  });
});

describe('unsubscribe-link HMAC lives in exactly one module (#5012 phase 2, NN #6)', () => {
  it('only scripts/lib/job-alert-unsub-urls.mjs derives the job-alert unsub token', () => {
    // Two BUILDERS drifting from one verifier means the user's unsubscribe
    // click fails as "invalid token" — an unsubscribe that does not
    // unsubscribe. One builder module, imported by both senders.
    const fingerprint = 'job_alert_unsub:';
    expect(readRepoFile('scripts/lib/job-alert-unsub-urls.mjs')).toContain(fingerprint);
    expect(readRepoFile('scripts/send-job-alerts.mjs').includes(fingerprint)).toBe(false);
    expect(readRepoFile('scripts/send-company-alerts.mjs').includes(fingerprint)).toBe(false);
  });

  it('the Cloud Function VERIFIER still derives byte-identical tokens', async () => {
    // functions/src/jobAlertUnsubscribe.js is the third file in this token's
    // life and it cannot import the builder — the functions bundle resolves
    // nothing outside `functions/`. So it stays a deliberate pinned mirror,
    // and parity is asserted here instead of hoped for. Exactly the remedy
    // #5151 applied to normalizeCompanyAlertKey.
    //
    // Surfaced by the sibling-patterns gate on the extraction commit, and it
    // was a genuine sibling: without this test the builder could be edited
    // (a trim, a lowercase, a prefix rename) and every unsubscribe link in
    // production would start failing verification with no test turning red.
    const { generateAlertUnsubToken, generateAllAlertsUnsubToken } =
      await import('../functions/src/jobAlertUnsubscribe.js');
    const { makeAlertUnsubscribeUrl, makeAllAlertsUnsubscribeUrl } =
      await import('../scripts/lib/job-alert-unsub-urls.mjs');

    const previous = process.env.NEWSLETTER_SECRET;
    process.env.NEWSLETTER_SECRET = 'test-secret-#5012';
    try {
      for (const [alertId, email] of [
        ['alert-1', 'a@b.ch'],
        ['alert-2', '  Mixed.Case@Example.COM  '],
      ] as const) {
        const builtOne = new URL(makeAlertUnsubscribeUrl(alertId, email)).searchParams.get('token');
        expect(builtOne).toBe(generateAlertUnsubToken(alertId, email, 'test-secret-#5012'));

        const builtAll = new URL(makeAllAlertsUnsubscribeUrl(email)).searchParams.get('token');
        expect(builtAll).toBe(generateAllAlertsUnsubToken(email, 'test-secret-#5012'));
      }
    } finally {
      if (previous === undefined) delete process.env.NEWSLETTER_SECRET;
      else process.env.NEWSLETTER_SECRET = previous;
    }
  });
});

describe('token-mode Cloud Function accepts the immediate cadence (#5012 phase 2)', () => {
  const cf = readRepoFile('functions/src/newsletterSubscriptionManagement.js');

  it('normalizeFrequency round-trips `immediate`', () => {
    // Rejecting it would make the /preferenze-newsletter/ token path silently
    // rewrite a followed employer back onto the digest — the same field written
    // by two paths with two different values.
    const fn = /function normalizeFrequency\(value\) \{[\s\S]*?\n\}/.exec(cf)?.[0] || '';
    expect(fn).toBeTruthy();
    // eslint-disable-next-line no-new-func
    const normalize = new Function(`${fn}; return normalizeFrequency;`)() as (v: unknown) => string | null | undefined;
    expect(normalize('immediate')).toBe('immediate');
    expect(normalize('IMMEDIATE')).toBe('immediate');
    expect(normalize('daily')).toBe('daily');
    expect(normalize('weekly')).toBe('weekly');
    expect(normalize('hourly')).toBeNull();
    expect(normalize(undefined)).toBeUndefined();
  });

  it('the preferences UI has a label for it instead of falling back to «periodico»', () => {
    const ui = readRepoFile('components/preferences/SubscriptionPreferencesController.tsx');
    expect(ui).toContain("if (f === 'immediate') return S.frequencyImmediate;");
    for (const label of ['immediato', 'immediate', 'sofort', 'immédiat']) {
      expect(ui, `missing ${label}`).toContain(`frequencyImmediate: '${label}'`);
    }
  });

  it('the in-app alert manager does not mislabel or silently downgrade it', () => {
    // Sibling of the formatFrequency fix above, surfaced by the
    // sibling-patterns gate and genuine: JobAlertForm rendered the cadence as
    // a `daily ? … : weekly` BINARY, so every immediate CompanyAlert read
    // "Settimanale". Worse, its <select> had no `immediate` option, so the
    // control showed no selection and the first interaction rewrote a followed
    // employer onto the digest — a downgrade the user never asked for.
    const form = readRepoFile('components/community/JobAlertForm.tsx');
    expect(form).toContain("alert.frequency === 'immediate'");
    expect(form).toContain('<option value="immediate">');
    expect(form.includes("alert.frequency === 'daily' ? (t('jobAlert.daily')")).toBe(false);
    for (const [loc, label] of [['it', 'Immediata'], ['en', 'Immediate'], ['de', 'Sofort'], ['fr', 'Immédiate']] as const) {
      expect(readRepoFile(`services/locales/${loc}-core.ts`), `${loc} missing jobAlert.immediate`)
        .toContain(`'jobAlert.immediate': '${label}'`);
    }
  });
});

describe('anonymous capture + double opt-in (#5012 phase 2)', () => {
  const intent = {
    company: 'Board International SA',
    companyKey: null,
    locale: 'it' as const,
    sourceJobSlug: 'sviluppatore-full-stack',
    sourceJobUrl: 'https://frontaliereticino.ch/lavoro/sviluppatore-full-stack/',
    sourceJobTitle: 'Sviluppatore Full Stack',
    email: 'Anon@Example.COM',
  };

  beforeEach(() => {
    clearPendingCompanyFollows();
    addDocMock.mockClear();
    getDocsMock.mockResolvedValue({ size: 0, docs: [] });
  });

  it('parking a follow writes NO alert — consent first, subscription second', async () => {
    savePendingCompanyFollow(intent);
    expect(addDocMock).not.toHaveBeenCalled();
    expect(readPendingCompanyFollows()).toHaveLength(1);
    // Normalised, so the flush keyed on the confirmed address finds it.
    expect(readPendingCompanyFollows()[0].email).toBe('anon@example.com');
  });

  it('de-dups repeated taps on the same employer', () => {
    savePendingCompanyFollow(intent);
    savePendingCompanyFollow(intent);
    expect(readPendingCompanyFollows()).toHaveLength(1);
  });

  it('replays the parked follow once the address is confirmed', async () => {
    savePendingCompanyFollow(intent);
    const subscribe = vi.fn(async () => ({ id: 'created-1' }));
    const created = await flushPendingCompanyFollows('uid-1', 'anon@example.com', subscribe as never);
    expect(created).toHaveLength(1);
    expect(subscribe).toHaveBeenCalledWith(
      'uid-1',
      'anon@example.com',
      { name: 'Board International SA', companyKey: null },
      'it',
      {
        slug: 'sviluppatore-full-stack',
        url: 'https://frontaliereticino.ch/lavoro/sviluppatore-full-stack/',
        title: 'Sviluppatore Full Stack',
      },
    );
    // Cleared, so a later page load cannot create a duplicate alert.
    expect(readPendingCompanyFollows()).toHaveLength(0);
  });

  it('never replays another visitor\'s parked follow on a shared device', async () => {
    savePendingCompanyFollow(intent);
    const subscribe = vi.fn(async () => ({ id: 'x' }));
    expect(await flushPendingCompanyFollows('uid-2', 'someone.else@example.com', subscribe as never)).toEqual([]);
    expect(subscribe).not.toHaveBeenCalled();
    expect(readPendingCompanyFollows()).toHaveLength(1);
  });

  it('clears the queue even when the write keeps failing', async () => {
    savePendingCompanyFollow(intent);
    const subscribe = vi.fn(async () => { throw new Error('Maximum 10 active alerts per user.'); });
    expect(await flushPendingCompanyFollows('uid-1', 'anon@example.com', subscribe as never)).toEqual([]);
    // Otherwise a permanently-failing intent retries on every page load forever.
    expect(readPendingCompanyFollows()).toHaveLength(0);
  });

  it('reuses the shared pending-intent store instead of a fourth localStorage helper', () => {
    // services/pendingIntentStore.ts already exists for exactly this problem
    // ("survives the auth round-trip … including a magic-link email that opens
    // in a brand-new tab") and is already shared by pendingJobAlert.ts and
    // pendingSaveJob.ts. Surfaced by the sibling-patterns gate; the first draft
    // of this module hand-rolled getItem/setItem/try-catch/TTL again.
    const src = readRepoFile('services/companyFollowIntent.ts');
    expect(src).toContain("from './pendingIntentStore'");
    expect(src.includes('localStorage.setItem')).toBe(false);
    expect(src.includes('localStorage.getItem')).toBe(false);
    // …but NOT its 15-minute default: a double-opt-in email can sit unread for
    // a day, and the default would silently drop the follow while the UI still
    // says "controlla la posta".
    expect(src).toContain('peekIntent<PendingCompanyFollow[]>(KEY, PENDING_FOLLOW_TTL_MS)');
    expect(PENDING_FOLLOW_TTL_MS).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it('expires a stale intent — an old click is not consent', () => {
    const now = Date.now();
    const fresh = { ...intent, savedAt: now - 1000 };
    const stale = { ...intent, company: 'Coop', savedAt: now - PENDING_FOLLOW_TTL_MS - 1000 };
    expect(pruneExpired([fresh, stale], now).map((e) => e.company)).toEqual(['Board International SA']);
  });

  it('the follow CTA is no longer hidden from anonymous visitors', () => {
    // Phase 1 mounted it behind `userId && userEmail`, i.e. hid it from exactly
    // the visitor whose email the feature exists to acquire, and the component
    // itself early-returned null.
    const board = readRepoFile('components/community/JobBoard.tsx');
    expect(board.includes('{userId && userEmail && selectedJob.company && (')).toBe(false);

    const button = readRepoFile('components/community/CompanyFollowButton.tsx');
    expect(button.includes('if (!slug || !userId || !email) return null;')).toBe(false);
    expect(button).toContain('if (!signedIn) { setStatus(\'capture\'); return; }');
  });

  it('renders the CTA in the AUTH-GATED branch too, not only the unlocked one', () => {
    // The defect this pins, measured live on 2026-08-06: the CTA existed only
    // after `if (!hasAccess) return <gate/>`, so a logged-out visitor — the
    // anonymous-capture path's whole target — never saw it on any job page.
    // Nothing caught it because the gating was 1200 lines above the call site,
    // in control flow, while the component's own comment claimed the opposite.
    const board = readRepoFile('components/community/JobBoard.tsx');
    const gateBranch = board.indexOf('if (!hasAccess) {');
    const gateCta = board.indexOf("companyFollowCta(selectedJob, 'company_follow_gate')");
    const unlockedCta = board.indexOf("companyFollowCta(selectedJob, 'company_follow_button')");

    expect(gateBranch).toBeGreaterThan(0);
    // Inside the gated branch…
    expect(gateCta).toBeGreaterThan(gateBranch);
    // …and again in the unlocked detail that follows it.
    expect(unlockedCta).toBeGreaterThan(gateCta);

    // ONE definition feeding both surfaces, and it is the SHARED component:
    // a second <CompanyFollowButton> literal in this file would be a second set
    // of analytics/cache callbacks free to drift from the other three surfaces.
    expect(board.split('<CompanyFollowCta').length - 1).toBe(1);
    expect(board.includes('<CompanyFollowButton')).toBe(false);

    // The surfaces must stay separable in analytics — the gated CTA competes
    // with the sign-in for the same click.
    expect(readRepoFile('services/analytics.ts')).toContain("'company_follow_gate'");
  });

  it('reuses the site\'s ONE opt-in mechanism instead of a second one', () => {
    // upsertNewsletterSubscriber writes status:'pending' and auto-fires
    // newsletterSendConfirmation; an ALREADY-KNOWN address needs the explicit
    // purpose:'login' link (SaveSignInPromptModal's precedent) or the visitor
    // gets no email at all and is never followed — silently.
    const button = readRepoFile('components/community/CompanyFollowButton.tsx');
    expect(button).toContain('upsertNewsletterSubscriber');
    expect(button).toContain("requestConfirmationEmail(trimmed, 'login')");
    expect(button).toContain('consentGiven: true');
    // No bespoke token, no bespoke confirmation endpoint.
    expect(button.includes('createHmac')).toBe(false);

    // The replay hangs off the EXISTING confirm handler, not a new route.
    const app = readRepoFile('App.tsx');
    expect(app).toContain('flushPendingCompanyFollows');
    expect(app).toContain("action === 'confirm_newsletter'");
  });
});

describe('CTA on the SSG employer pages /aziende/<slug>/ (#5012 requisito 1)', () => {
  it('emits a hydration island, not a second copy of the button', () => {
    // /aziende/<slug>/ resolves to { activeTab: 'job-board', staticOverlay: true },
    // so the SPA renders header+footer only and the static body stays visible —
    // an interactive CTA there has to be an island. It reuses the pattern that
    // already exists (newsletterMountPlaceholder → NewsletterMount) and mounts
    // the SAME CompanyFollowButton: a copy would be a second surface free to
    // drift from the matcher, silently.
    const mount = readRepoFile('components/community/CompanyFollowMount.tsx');
    // Mounts the shared CTA, which renders the SAME CompanyFollowButton every
    // other surface uses — never a second copy of the button here.
    expect(mount).toContain("import CompanyFollowCta, { type CompanyFollowSurface } from './CompanyFollowCta'");
    expect(readRepoFile('components/community/CompanyFollowCta.tsx'))
      .toContain("import CompanyFollowButton from './CompanyFollowButton'");
    expect(mount).toContain("attribute: 'data-company-follow-mount'");
    expect(mount).toContain("mountedAttribute: 'data-company-follow-mounted'");
  });

  it('the scan/portal loop lives in ONE hook, shared with NewsletterMount', () => {
    // Surfaced by the sibling-patterns gate on the island commit: the first
    // draft re-typed NewsletterMount's scan loop. Four details in it are each a
    // bug when forgotten — createPortal appends (skeleton stays underneath), the
    // MutationObserver re-fires on its own mutations (infinite re-add), an SPA
    // navigation swaps the static body (one-shot scan stops hydrating), and a
    // re-scan must append rather than replace (portals from the previous page
    // unmount). Non-Negotiable #6.
    for (const rel of [
      'components/community/CompanyFollowMount.tsx',
      'components/community/NewsletterMount.tsx',
    ]) {
      const src = readRepoFile(rel);
      expect(src, `${rel} must use the shared hook`).toContain("from '@/hooks/useHydrationIslands'");
      expect(src.includes('new MutationObserver'), `${rel} re-implements the scan loop`).toBe(false);
      expect(src.includes("el.innerHTML = ''"), `${rel} re-implements the container clear`).toBe(false);
    }
    const hook = readRepoFile('hooks/useHydrationIslands.ts');
    expect(hook).toContain("el.innerHTML = ''");
    expect(hook).toContain('new MutationObserver');
    expect(hook).toContain("window.addEventListener('popstate'");
    expect(hook).toContain('setTargets((prev) => [...prev, ...next])');
  });

  it('is mounted unconditionally from App.tsx, like NewsletterMount', () => {
    // Gating it on a route would mean re-parsing the pathname: the employer
    // route carries no slug in its AppRoute (`{ activeTab: 'job-board',
    // staticOverlay: true }`). The scan is one querySelectorAll that matches
    // nothing everywhere else.
    const app = readRepoFile('App.tsx');
    expect(app).toContain('boundary="company-follow-mount"');
    expect(app).toContain("React.lazy(() => import('@/components/community/CompanyFollowMount'))");
  });

  it('hands the button raw name + companyKey so the token cannot diverge from the URL', () => {
    const html = companyFollowMountPlaceholder({
      company: 'Migros Ticino',
      companyKey: 'migros-ti',
      locale: 'it',
      surface: 'employer_profile',
    });
    expect(html).toContain('data-company="Migros Ticino"');
    expect(html).toContain('data-company-key="migros-ti"');
    // NOT the precomputed slug: companyAlertKey re-derives it through the one
    // shared normalisation, which is also what built this page's URL.
    expect(html.includes('data-company-slug')).toBe(false);
    expect(companyAlertKey('Migros Ticino', 'migros-ti')).toBe('migros');
  });

  it('escapes the employer name into the data attribute', () => {
    const html = companyFollowMountPlaceholder({
      company: 'Bürgenstock Hotels & Resort',
      companyKey: null,
      locale: 'it',
      surface: 'employer_profile',
    });
    expect(html).toContain('data-company="Bürgenstock Hotels &amp; Resort"');
  });

  it('emits nothing for a nameless employer', () => {
    // companyAlertKey('') is '' → the button would render null and strand an
    // empty box on the page.
    expect(companyFollowMountPlaceholder({ company: '', locale: 'it', surface: 'employer_profile' })).toBe('');
  });

  it('the skeleton label matches the hydrated button in all four locales', () => {
    // The label is duplicated in the build plugin (it cannot import the runtime
    // i18n bundle). Duplicated, therefore asserted: a drifted skeleton would
    // swap visible text at hydration.
    for (const [loc, key] of [['it', 'it'], ['en', 'en'], ['de', 'de'], ['fr', 'fr']] as const) {
      const html = companyFollowMountPlaceholder({ company: 'Acme', locale: loc, surface: 'employer_profile' });
      const label = /border-edge bg-surface-raised text-muted">([^<]+)</.exec(html)?.[1] || '';
      expect(label, `${loc} label missing`).toBeTruthy();
      expect(readRepoFile(`services/locales/${key}-core.ts`), `${loc} drifted from jobAlert.companyFollow.cta`)
        .toContain(`'jobAlert.companyFollow.cta': '${label}'`);
    }
  });

  it('an unknown locale falls back instead of emitting an empty label', () => {
    const html = companyFollowMountPlaceholder({ company: 'Acme', locale: 'xx', surface: 'employer_profile' });
    expect(html).toContain('Segui questa azienda');
  });

  it('the placeholder\'s data-surface reaches analytics instead of being dropped', () => {
    // `readProps` read `data-surface` and the tracker then hardcoded
    // 'company_follow_button', so the full profile page and the thin
    // below-floor stub were indistinguishable in the data — the prop was live
    // on one line and dead on the next.
    const mount = readRepoFile('components/community/CompanyFollowMount.tsx');
    expect(mount).toContain("employer_profile: 'company_follow_profile'");
    expect(mount).toContain("employer_below_floor: 'company_follow_below_floor'");
    // The mapped value must reach the CTA, not be read and dropped.
    expect(mount).toContain("surface: ANALYTICS_SURFACE[el.dataset.surface || ''] || 'company_follow_profile'");
    expect(mount).toContain('surface={t.props.surface}');

    const analytics = readRepoFile('services/analytics.ts');
    expect(analytics).toContain("'company_follow_profile'");
    expect(analytics).toContain("'company_follow_below_floor'");

    // Both surface values must still be emitted by the plugin, or the mapping
    // above silently degrades to its fallback.
    const plugin = readRepoFile('build-plugins/employerProfilePagesPlugin.ts');
    expect(plugin).toContain("surface: 'employer_profile'");
    expect(plugin).toContain("surface: 'employer_below_floor'");
  });
});

describe('«Le mie aziende seguite» page (#5012 phase 2)', () => {
  it('has a slug in all four locales', () => {
    const table = readRepoFile('services/routeSlugs.data.ts');
    for (const slug of ['aziende-seguite', 'followed-companies', 'gefolgte-unternehmen', 'entreprises-suivies']) {
      expect(table, `missing ${slug}`).toContain(`followedCompanies: '${slug}'`);
    }
  });

  it('is wired into the router in every direction', () => {
    const router = readRepoFile('services/router.ts');
    expect(router).toContain("| 'followed-companies';");           // ActiveTab
    expect(router).toContain("[table.followedCompanies]: { tab: 'followed-companies' }"); // slug → tab
    expect(router).toContain('return finish(`${prefix}/${table.followedCompanies}${hashSuffix}`);'); // tab → path
  });

  it('cannot collide with the /aziende/<slug>/ employer-profile namespace', () => {
    // The employer hub matches an EXACT `/aziende/` segment, so the sibling
    // top-level slug `aziende-seguite` is a different path. Asserted rather
    // than assumed: an accidental collision would shadow every employer page.
    const employerHubRe = /^\/aziende\/[a-z0-9][a-z0-9-]*\/?$/;
    expect(employerHubRe.test('/aziende/board-international/')).toBe(true);
    expect(employerHubRe.test('/aziende-seguite/')).toBe(false);
  });

  it('stays PRIVATE — no sitemap/SEO registration, matching newsletterPreferences', () => {
    // seo-completeness.test.ts requires every route in its `standalones` list
    // to have a sitemap <loc>, an IndexNow entry and a SEO_METADATA record.
    // Authed pages are private by OMISSION from that list; adding this one
    // would both break the gate and index a logged-in page.
    const seoCompleteness = readRepoFile('tests/seo-completeness.test.ts');
    expect(seoCompleteness.includes("'followed-companies'")).toBe(false);
    expect(seoCompleteness.includes("'newsletter-preferences'")).toBe(false);
  });

  it('ships its copy in all four locales without touching the shared i18n keyspace', () => {
    // NewsletterPreferences.tsx's pattern: a local STRINGS map keeps a private
    // page self-contained and still complete in four languages.
    const page = readRepoFile('components/pages/FollowedCompaniesPage.tsx');
    expect(page).toContain('const STRINGS: Record<Locale, PageStrings>');
    for (const title of ['Le mie aziende seguite', 'Companies I follow', 'Meine gefolgten Unternehmen', 'Mes entreprises suivies']) {
      expect(page, `missing ${title}`).toContain(title);
    }
  });

  it('reads its data without a new Firestore query', () => {
    const svc = readRepoFile('services/jobAlertService.ts');
    expect(svc).toContain('export async function listFollowedCompanies');
    // Derived from getUserAlerts, which reuses the deployed composite index.
    const fn = /export async function listFollowedCompanies[\s\S]*?\n\}/.exec(svc)?.[0] || '';
    expect(fn).toContain('getUserAlerts(userId)');
    expect(fn.includes('query(')).toBe(false);
  });
});

describe('the CTA reaches every job-detail surface (#5012)', () => {
  // A job detail is drawn by FOUR components depending on the ad's state, each
  // with its own auth gate. Phase 2 wired the CTA into one of them.
  const SURFACES: Array<[string, string]> = [
    ['components/community/JobBoard.tsx', 'company_follow_gate'],
    ['components/community/JobBoard.tsx', 'company_follow_button'],
    ['components/community/JobExpiredView.tsx', 'company_follow_expired'],
    ['components/community/JobOrphanView.tsx', 'company_follow_orphan'],
  ];

  it.each(SURFACES)('%s renders the CTA as %s', (file, surface) => {
    expect(readRepoFile(file)).toContain(surface);
  });

  it('every surface name is a member of the analytics union AND of CompanyFollowSurface', () => {
    // Two unions, one truth: the tracker's and the component's. A name in the
    // component that the tracker does not know is a type error at build time;
    // the reverse is a surface nobody reports.
    const analytics = readRepoFile('services/analytics.ts');
    const cta = readRepoFile('components/community/CompanyFollowCta.tsx');
    for (const name of [
      'company_follow_button', 'company_follow_gate', 'company_follow_profile',
      'company_follow_below_floor', 'company_follow_orphan', 'company_follow_expired',
    ]) {
      expect(analytics, `${name} missing from analytics`).toContain(`'${name}'`);
      expect(cta, `${name} missing from CompanyFollowSurface`).toContain(`'${name}'`);
    }
  });

  it('the orphan view follows only an employer the slug actually matched', () => {
    // slugParts.company is null when no known employer matched. Following a
    // guessed name would persist an alert key that never matches a job — an
    // subscription that silently never fires.
    const orphan = readRepoFile('components/community/JobOrphanView.tsx');
    expect(orphan).toContain('const companyFollowCta = slugParts.company ?');
    // …and reuses the ONE derived key, rather than re-deriving a second one
    // that could disagree about which employer the slug names.
    expect(orphan).toContain('const derivedCompanyKey = useMemo(');
    expect(orphan).toContain('companyKey={derivedCompanyKey || null}');
  });

  it('the alerts cache is shared, so a follow from any surface invalidates it', () => {
    // It used to be file-private to JobBoard.tsx: a follow from the expired,
    // orphan or SSG employer surface left every cached eligibility read in the
    // session one write behind.
    const cache = readRepoFile('services/userAlertsCache.ts');
    expect(cache).toContain('export function invalidateUserAlertsCache');
    expect(cache).toContain('export function fetchUserAlertsCached');
    expect(readRepoFile('components/community/CompanyFollowCta.tsx'))
      .toContain("import { invalidateUserAlertsCache } from '@/services/userAlertsCache'");
    const board = readRepoFile('components/community/JobBoard.tsx');
    expect(board).toContain("from '@/services/userAlertsCache'");
    expect(board.includes('let cachedUserAlerts')).toBe(false);
  });
});

describe('cadence per followed company (#5012 fase 2 — frequenze)', () => {
  const page = () => readRepoFile('components/pages/FollowedCompaniesPage.tsx');

  it('offers the three cadences the router partition actually knows', () => {
    // Any value outside this set would land in the digest by default while the
    // UI implied something else: `isImmediateCompanyAlert` claims exactly
    // `immediate`, scripts/send-job-alerts.mjs claims the rest.
    expect(page()).toContain("const CADENCES = ['immediate', 'daily', 'weekly'] as const");
  });

  it('pins the manual pick so the adaptive engine cannot undo it', () => {
    // Same contract as JobAlertForm's picker: without frequencyOverride the
    // cadence engine is free to move the alert back and the control looks like
    // it silently forgot the setting.
    expect(page()).toContain('frequencyOverride: true');
    expect(page()).toContain('updateAlert(alert.email, alert.id, { frequency: next, frequencyOverride: true })');
  });

  it('never shows an unknown cadence as "digest"', () => {
    // Falling back to 'daily' would print "in the daily digest" over an alert
    // the IMMEDIATE sender is in fact still sending — a row that lies about
    // which pipeline owns it.
    expect(page()).toContain(
      "alert.frequency === 'daily' || alert.frequency === 'weekly' ? alert.frequency : 'immediate'",
    );
  });

  it('rolls the row back when the write fails', () => {
    // Optimistic + rollback: a failed save that left the new value on screen
    // would tell the user they are on a cadence the backend never stored.
    const src = page();
    expect(src).toContain('followedCompanies.cadence');
    expect(src).toContain('frequency: previous');
  });

  it('ships the cadence copy in all four locales', () => {
    const src = page();
    for (const key of ['cadenceLabel', 'cadenceImmediate', 'cadenceDaily', 'cadenceWeekly', 'weeklyBadge', 'saveError']) {
      // 4 locale blocks + the one PageStrings field declaration = 5. A missing
      // locale drops to 4 and fails here rather than rendering `undefined` to
      // a German or French reader.
      expect(src.split(`${key}:`).length - 1, `${key} is not in all four locales`).toBe(5);
      expect(src, `${key} missing from PageStrings`).toContain(`${key}: string;`);
    }
  });
});

describe('CTA on the per-employer city hubs /aziende-che-assumono/ (#5012)', () => {
  it('the weekly-employers company×city page emits the island', () => {
    // The last SSG surface that names ONE employer and had no follow CTA. Its
    // route is `staticOverlay: true` (services/router.ts, parseCompanyCityPath),
    // so the CTA has to be an island exactly like the employer profile's.
    const plugin = readRepoFile('build-plugins/weeklyEmployersPlugin.ts');
    expect(plugin).toContain("from './shared/companyFollowMountPlaceholder'");
    expect(plugin).toContain("surface: 'employer_city'");
    // Same normalisation as the page's own URL: the employer key the stats
    // record carries, not a re-slugified display name.
    expect(plugin).toContain('companyKey: stats.employerKey');
  });

  it('the new surface is mapped and reportable end to end', () => {
    expect(readRepoFile('components/community/CompanyFollowMount.tsx'))
      .toContain("employer_city: 'company_follow_city'");
    expect(readRepoFile('components/community/CompanyFollowCta.tsx')).toContain("'company_follow_city'");
    expect(readRepoFile('services/analytics.ts')).toContain("'company_follow_city'");
  });

  it('the route really is a hydrating staticOverlay page', () => {
    // An island on a route the SPA does not recognise renders a dead skeleton —
    // the exact failure mode #5012 shipped once already.
    const router = readRepoFile('services/router.ts');
    expect(router).toContain('const companyCityMatch = parseCompanyCityPath(pathname)');
    expect(router).toContain("route: { activeTab: 'job-board', staticOverlay: true }");
  });
});

describe('«aziende seguite» — logo and bulk unfollow (#5012)', () => {
  const page = () => readRepoFile('components/pages/FollowedCompaniesPage.tsx');

  it('resolves the logo through the shared map, not a new source', () => {
    expect(page()).toContain("import { resolveCompanyLogoUrl } from '@/services/jobDataNormalization'");
    expect(page()).toContain('resolveCompanyLogoUrl({ company: companyLabelFromSlug(slug), companyKey: slug })');
    // Broken/missing logos fall back to the same handler the job cards use.
    expect(page()).toContain('onError={handleCompanyLogoError}');
  });

  it('unfollow-all confirms first and deletes sequentially', () => {
    const src = page();
    expect(src).toContain('window.confirm(S.unfollowAllConfirm)');
    // Sequential: a partial failure must keep the rows it could not delete
    // visible instead of clearing a list the backend still holds.
    expect(src).toContain('for (const alert of rows)');
    expect(src.includes('Promise.all(rows')).toBe(false);
    expect(src).toContain('setAlerts(failed)');
  });

  it('ships the bulk-unfollow copy in all four locales', () => {
    const src = page();
    for (const key of ['unfollowAll', 'unfollowAllConfirm']) {
      expect(src.split(`${key}:`).length - 1, `${key} is not in all four locales`).toBe(5);
    }
  });
});

describe('the three deferred items (#5012 — closing the «Non implementato» list)', () => {
  it('publishes a SLIM count map, not the 443 KB dataset', () => {
    const plugin = readRepoFile('build-plugins/employerProfilePagesPlugin.ts');
    expect(plugin).toContain("'employer-job-counts.json'");
    // Only slugs that got a page: a count linking to a 404 is worse than none.
    expect(plugin).toContain('employerJobCounts.set(slug, profile.activeJobs)');
    expect(plugin).toContain('employerJobCounts.set(slug, rec.activeJobs)');
    // dist/data/ is the prefix deploy-it-pages-prep.sh syncs to R2 (max-age=600).
    expect(plugin).toContain("np.join(distDir, 'data')");

    const page = readRepoFile('components/pages/FollowedCompaniesPage.tsx');
    // The reader of that map lives in hooks/useEmployerHub.ts — one fetch, one
    // cache, shared with the job surfaces that link the hub. This page consumes
    // it instead of opening a second one.
    expect(page).toContain('fetchEmployerHubCounts()');
    expect(readRepoFile('hooks/useEmployerHub.ts')).toContain("'/data/employer-job-counts.json'");
    // Decorative: a failed fetch must not become an error state on a page whose
    // job is letting people unsubscribe.
    expect(page).toContain('.catch(() => {');
    expect(page).toContain('employerOpenRolesLabel(jobCounts[slug], locale)');
  });

  it('the email\'s manage link deep-links to the page that manages follows', () => {
    const sender = readRepoFile('scripts/send-company-alerts.mjs');
    expect(sender).toContain('followedCompaniesPath(locale)');
    // Wrapped: /aziende-seguite/ reads the signed-in user, and `wrapUrl` adds
    // the ne+ac pair App.tsx exchanges on ANY route.
    expect(sender).toContain('const manageUrl = wrapUrl(');
    // The way OUT must never depend on that exchange.
    expect(sender).toContain('makeAlertUnsubscribeUrl(alert.id, recipient)');
  });

  it('the duplicated followed-companies slug matches the router', () => {
    // The sender runs under plain `node` and cannot import the TS route table,
    // so the slug is duplicated — and therefore asserted: a drift here sends
    // every reader of every CompanyAlert email to a 404.
    const sender = readRepoFile('scripts/send-company-alerts.mjs');
    const slug = /const FOLLOWED_COMPANIES_SLUG = '([^']+)'/.exec(sender)?.[1];
    expect(slug).toBeTruthy();
    expect(readRepoFile('services/routeSlugs.data.ts')).toContain(`followedCompanies: '${slug}'`);
  });

  it('company follows and keyword alerts hold SEPARATE budgets, mirrored everywhere', () => {
    // Following ten employers used to consume every alert slot, so the next
    // saved search failed with «Maximum 10 active alerts per user» — a message
    // naming neither the cause nor the fix.
    const svc = readRepoFile('services/jobAlertService.ts');
    expect(svc).toContain('export const MAX_COMPANY_ALERTS_PER_USER');
    expect(svc).toContain('const isCompanyPin = Boolean(config.specificCompanyKey)');
    expect(svc).toContain('sameKind >= kindCap');

    const cf = readRepoFile('functions/src/newsletterSubscriptionManagement.js');
    expect(cf).toContain('const MAX_COMPANY_ALERTS_PER_USER');
    expect(cf).toContain('Boolean(data.specificCompanyKey) === creatingCompanyPin');

    // Same number in both places, or the token-mode API and the signed-in UI
    // disagree about when a user is full.
    const svcCap = Number(/MAX_COMPANY_ALERTS_PER_USER = (\d+)/.exec(svc)?.[1]);
    const cfCap = Number(/MAX_COMPANY_ALERTS_PER_USER = (\d+)/.exec(cf)?.[1]);
    expect(svcCap).toBeGreaterThan(0);
    expect(cfCap).toBe(svcCap);

    // The newsletter backfill must not be blocked by follows either.
    expect(readRepoFile('functions/src/jobAlertBackfillTrigger.js'))
      .toContain('!d.data().specificCompanyKey');
  });
});

describe('the follow CTA copy exists in all four locales (#5012 phase 2)', () => {
  it.each(['it', 'en', 'de', 'fr'])('%s-core carries every companyFollow key', (loc) => {
    const src = readRepoFile(`services/locales/${loc}-core.ts`);
    for (const key of [
      'jobAlert.companyFollow.cta',
      'jobAlert.companyFollow.following',
      'jobAlert.companyFollow.hint',
      'jobAlert.companyFollow.followingHint',
      'jobAlert.companyFollow.error',
      // Phase 2 — the anonymous capture states.
      'jobAlert.companyFollow.emailLabel',
      'jobAlert.companyFollow.emailHint',
      'jobAlert.companyFollow.optInSentTitle',
      'jobAlert.companyFollow.optInSentBody',
      'jobAlert.companyFollow.manageAll',
    ]) {
      expect(src, `${loc} is missing ${key}`).toContain(`'${key}'`);
    }
  });
});
