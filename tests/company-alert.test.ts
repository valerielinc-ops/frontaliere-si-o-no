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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  deleteField: vi.fn(() => '__delete_field__'),
  getFirestore: vi.fn(() => ({})),
}));

import {
  companyAlertKey,
  MAX_ALERTS_PER_USER,
  MAX_COMPANY_ALERTS_PER_USER,
  subscribeCompanyAlert,
} from '@/services/jobAlertService';
import {
  allocateCompanyAlertCards,
  buildCompanyAlertEmail,
  companyHubUrl,
  COMPANY_ALERT_MAX_CARDS,
  COMPANY_ALERT_MAX_TOTAL_CARDS,
  COMPANY_ALERT_STRINGS,
  COMPANY_ALERT_TEMPLATE_ID,
} from '@/services/companyAlertEmail.mjs';
import { formatSalary, resolveLogoUrl } from '@/services/newsletter-content.mjs';
import {
  NEWSLETTER_AFFILIATE_ENTRIES,
  NEWSLETTER_SPONSORS,
  renderRecommendedBlock,
} from '@/services/newsletter/recommendedBlock.mjs';
import { dataControllerFooterLine } from '../functions/src/lib/dataControllerIdentity.js';
import { isImmediateCompanyAlert } from '../scripts/lib/company-alert-routing.mjs';
import { companyFollowMountPlaceholder } from '../build-plugins/shared/companyFollowMountPlaceholder';
import {
  buildRecipientSections,
  DEDUP_CHUNK_SIZE,
  groupAlertsByRecipient,
  pickOneClickUnsubscribeUrl,
  selectNewlyPublishedJobs,
  selectPersistableSends,
} from '../scripts/send-company-alerts.mjs';
import { mergeSentJobs } from '../scripts/lib/alert-sent-jobs.mjs';
import { FIRESTORE_BATCH_SIZE } from '../scripts/lib/firestore-batch.mjs';
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

  it('the immediate sender narrows on cadence server-side, keeping `active` in the query', () => {
    // The old shape read every active alert (6.969 docs, production
    // 2026-08-24) to keep the 53 immediate ones, ~24 times a day. Two
    // equalities need no composite index — the automatic single-field
    // COLLECTION_GROUP indexes serve them by intersection — but `frequency`
    // WITHOUT `active` does throw FAILED_PRECONDITION, measured the same day.
    // So `active` stays, and it stays first.
    const sender = readRepoFile('scripts/send-company-alerts.mjs');
    expect(sender).toContain("collectionGroup('alerts').where('active', '==', true)");
    expect(sender).toContain("where('frequency', '==', IMMEDIATE_FREQUENCY)");
    // The cadence value is not re-derived here: it comes from the file that
    // owns the partition, same as isImmediateCompanyAlert.
    expect(sender).toContain("IMMEDIATE_FREQUENCY } from './lib/company-alert-routing.mjs'");
    expect(sender.includes("where('frequency', '==', 'immediate')")).toBe(false);
    // specificCompanyKey stays in memory: "has a value" is not an equality,
    // so it is the one filter that would need an index we do not deploy.
    expect(sender.includes("where('specificCompanyKey'")).toBe(false);
  });

  it('a refused narrow query falls back to the wide scan instead of sending nothing', () => {
    // If the index situation ever changes under us, the failure mode must be a
    // costlier run, never a silent never-send — the exact defect #5151 exists
    // to kill.
    const sender = readRepoFile('scripts/send-company-alerts.mjs');
    expect(sender).toContain('async function loadImmediateAlertDocs(db)');
    expect(sender).toContain('return base.get();');
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

describe('company_alert template — job-alert card, footer chrome, sponsored slot', () => {
  const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
  const richJob = {
    id: 'j-rich',
    title: 'Sviluppatore Full Stack',
    company: 'Board International SA',
    companyKey: 'board-international',
    location: 'Lugano',
    canton: 'TI',
    contract: 'full-time',
    salaryMin: 80000,
    salaryMax: 100000,
    currency: 'CHF',
    baseSalary: { value: { unitText: 'YEAR' } },
    firstSeenAt: new Date(NOW - 3 * 3600 * 1000).toISOString(),
    url: 'https://frontaliereticino.ch/lavoro/sviluppatore-full-stack/',
  };
  const build = (overrides: Record<string, unknown> = {}) => buildCompanyAlertEmail({
    companyName: 'Board International SA',
    companySlug: 'board-international',
    jobs: [richJob],
    email: 'a@b.ch',
    locale: 'it',
    manageUrl: 'https://frontaliereticino.ch/preferenze-newsletter/',
    unsubscribeUrl: 'https://frontaliereticino.ch/disiscrivi-alert/?x=1',
    unsubscribeAllUrl: 'https://frontaliereticino.ch/disiscrivi-alert/?all=1',
    now: NOW,
    ...overrides,
  });

  afterEach(() => {
    NEWSLETTER_SPONSORS.length = 0;
  });

  it('renders title, location, salary chip from the shared formatter, and contract chip', () => {
    const { html } = build();
    expect(html).toContain('Sviluppatore Full Stack');
    expect(html).toContain('Lugano');
    const salaryLabel = formatSalary(richJob, 'it');
    expect(salaryLabel).toBeTruthy();
    expect(html).toContain(salaryLabel as string);
    expect(html).toContain('Tempo pieno');
  });

  it('omits the salary chip entirely when salaryMin/salaryMax are absent — no empty CHF hole', () => {
    const { html } = build({
      jobs: [{ ...richJob, salaryMin: 0, salaryMax: 0, currency: undefined, baseSalary: undefined }],
    });
    expect(html).not.toMatch(/CHF\s+\d/);
  });

  it('renders a CDN brand <img> when companyKey hits the logo manifest, else the initial-letter fallback and no broken image', () => {
    const manifestPath = path.join(repoRoot, 'data/company-logos-manifest.json');
    const withLogo = build();
    const expectedLogo = resolveLogoUrl({ companyKey: 'board-international', company: 'Board International SA' });
    if (existsSync(manifestPath)) {
      expect(expectedLogo, 'board-international is in the committed logo manifest').toBeTruthy();
      expect(expectedLogo).toMatch(/^https:\/\/cdn\.frontaliereticino\.ch\/images\/brands\//);
      expect(withLogo.html).toContain(`<img src="${expectedLogo}"`);
      expect(withLogo.html).toContain('width="44" height="44"');
    } else {
      expect(expectedLogo).toBeNull();
      expect(withLogo.html).toMatch(/font-size:18px;font-weight:800;color:#f97316;">B<\/div>/);
    }
    expect(withLogo.html).not.toMatch(/google\.com\/s2\/favicons/);

    const { html: fallbackHtml } = build({
      companyName: 'Nonsense Long Tail Employer XYZ',
      companySlug: 'nonsense-long-tail-employer-xyz',
      jobs: [{
        ...richJob,
        company: 'Nonsense Long Tail Employer XYZ',
        companyKey: 'nonsense-long-tail-employer-xyz',
      }],
    });
    expect(fallbackHtml).not.toContain('<img');
    expect(fallbackHtml).not.toMatch(/google\.com\/s2\/favicons/);
    expect(fallbackHtml).toMatch(/font-size:18px;font-weight:800;color:#f97316;">N<\/div>/);
  });

  it('shows the NEW chip when firstSeenAt is within 48h of the caller-supplied now, and omits it otherwise', () => {
    const fresh = build();
    expect(fresh.html).toContain(COMPANY_ALERT_STRINGS.it.newBadge);

    const stale = build({
      jobs: [{ ...richJob, firstSeenAt: new Date(NOW - 5 * 86400 * 1000).toISOString() }],
    });
    expect(stale.html).not.toContain(COMPANY_ALERT_STRINGS.it.newBadge);

    const missing = build({ jobs: [{ ...richJob, firstSeenAt: undefined }] });
    expect(missing.html).not.toContain(COMPANY_ALERT_STRINGS.it.newBadge);
  });

  it('omits location and contract chips when those fields are missing — no empty hole', () => {
    const { html } = build({
      jobs: [{
        ...richJob,
        location: '',
        canton: '',
        addressLocality: '',
        contract: '',
        contractType: '',
        salaryMin: 0,
        salaryMax: 0,
        currency: undefined,
        baseSalary: undefined,
        firstSeenAt: undefined,
      }],
    });
    expect(html).toContain('Sviluppatore Full Stack');
    expect(html).not.toContain('Lugano');
    expect(html).not.toContain('Tempo pieno');
    expect(html).not.toMatch(/CHF\s+\d/);
    expect(html).not.toContain(COMPANY_ALERT_STRINGS.it.newBadge);
  });

  it('footer chrome matches job-alert: closer card, social row, copyright/spam, data-controller, unsub links', () => {
    const { html } = build();
    expect(html).toContain('segui questa azienda');
    expect(html).toContain(COMPANY_ALERT_STRINGS.it.closerSign);
    expect(html).toContain('facebook.com');
    expect(html).toContain('linkedin.com/company/frontaliere-ticino');
    expect(html).toContain('0% spam, 100% frontaliere');
    expect(html).toContain(dataControllerFooterLine('it'));
    expect(html).toContain('#94a3b8');
    expect(html).toContain('Smetti di seguire Board International SA');
    expect(html).toContain('Disattiva tutti gli avvisi');
    expect(html).toContain('https://frontaliereticino.ch/disiscrivi-alert/?x=1');
    expect(html).toContain('https://frontaliereticino.ch/disiscrivi-alert/?all=1');
    expect(html).not.toContain('Disiscriviti da questa alert');
  });

  it('interpolates the shared recommended-block renderer as a sibling <tr> after the job cards', () => {
    const src = readRepoFile('services/companyAlertEmail.mjs');
    expect(src).toMatch(/interest:\s*'jobs'/);
    expect(src).toMatch(/campaign:\s*COMPANY_ALERT_TEMPLATE_ID/);
    expect(src).toMatch(/\$\{recommendedBlockHtml\}/);
    expect(src).toMatch(/\$\{body\}\$\{monoCta\}[\s\S]*\$\{recommendedBlockHtml\}[\s\S]*closerSign/);
  });

  it('includes the sponsored-block disclosure when a partner is active, interpolating the shared renderer output', () => {
    NEWSLETTER_SPONSORS.push({
      id: 'acme-company-alert',
      name: 'Acme',
      emoji: '🏷️',
      url: 'https://acme.example/offer/',
      active: true,
      weight: 1,
      copy: {
        it: { title: 'Offerta Acme', body: 'Corpo IT', cta: 'Vai →' },
        en: { title: 'Acme offer', body: 'Body EN', cta: 'Go →' },
        de: { title: 'Acme Angebot', body: 'Body DE', cta: 'Los →' },
        fr: { title: 'Offre Acme', body: 'Body FR', cta: 'Aller →' },
      },
    });
    const block = renderRecommendedBlock({
      locale: 'it',
      interest: 'jobs',
      campaign: COMPANY_ALERT_TEMPLATE_ID,
    });
    expect(block.trim().startsWith('<tr>')).toBe(true);
    expect(block).toContain('Contenuto sponsorizzato');
    const { html } = build();
    expect(html).toContain(block.trim());
    expect(html).toContain('Contenuto sponsorizzato');
    expect(html).toContain('Offerta Acme');
  });

  it('keeps a balanced table when the recommended renderer returns the empty string', () => {
    const savedEntries = NEWSLETTER_AFFILIATE_ENTRIES.splice(0, NEWSLETTER_AFFILIATE_ENTRIES.length);
    try {
      expect(renderRecommendedBlock({ locale: 'it', interest: 'jobs', campaign: COMPANY_ALERT_TEMPLATE_ID })).toBe('');
      const { html } = build();
      expect(html).not.toContain('Contenuto sponsorizzato');
      expect(html).not.toContain('Consigliato per te');
      expect((html.match(/<tr/g) || []).length).toBe((html.match(/<\/tr>/g) || []).length);
      expect((html.match(/<table/g) || []).length).toBe((html.match(/<\/table>/g) || []).length);
      expect(html).toContain('0% spam, 100% frontaliere');
    } finally {
      NEWSLETTER_AFFILIATE_ENTRIES.push(...savedEntries);
    }
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
    // Was `consentGiven: true` until #5712, which removed the claim: this form
    // has no consent checkbox, so nothing here is an affirmative opt-in and
    // asserting one would let `hasAffirmativeJobAlertConsent` create job
    // alerts for people who only typed an address to follow an employer. The
    // shared mechanism this test is really about is the register: one formula,
    // rendered and stored by the same function.
    expect(button).toContain("consentProof('communicationsOptIn'");
    expect(button).toContain('<ConsentNotice consentKey="communicationsOptIn"');
    expect(button).not.toContain('consentGiven: true');
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
    expect(sender).toContain('makeAlertUnsubscribeUrl(section.alert.id, recipient)');
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

// ─────────────────────────────────────────────────────────────────────────────
// RESIDUO #5283: one email per RECIPIENT, not per alert.
//
// The defect these pin, in one sentence: scripts/send-company-alerts.mjs
// iterated ALERTS and sent one email each, so following ten employers that
// published inside the same 6h window put TEN emails in one inbox within
// seconds. Everything below is pure — no Firestore, no clock beyond an injected
// `now` — because the grouping and the dedup are the two things that must be
// provable, and a test that needs an emulator to prove them will not be run.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

type FakeAlert = Record<string, unknown>;
const alertDoc = (id: string, email: string, slug: string, extra: FakeAlert = {}): FakeAlert => ({
  id,
  ref: { id: `ref-${id}` },
  email,
  locale: 'it',
  frequency: 'immediate',
  specificCompanyKey: slug,
  ...extra,
});
const jobDoc = (id: string, company: string, ageHours: number, title = `Ruolo ${id}`) => ({
  id,
  title,
  company,
  location: 'Lugano',
  canton: 'TI',
  firstSeenAt: hoursAgo(ageHours),
  url: `https://frontaliereticino.ch/lavoro/${id}/`,
});

describe('grouping: one email per recipient (residuo #5283)', () => {
  it('buckets every alert of one person into ONE email, case-insensitively', () => {
    // job_alert_subscribers/{email} is keyed lowercased by every other writer;
    // a mixed-case bucket here would split one person into two inboxes and undo
    // the grouping without a single error anywhere.
    const grouped = groupAlertsByRecipient([
      alertDoc('a1', 'Foo@Example.COM', 'board-international'),
      alertDoc('a2', 'foo@example.com', 'lidl'),
      alertDoc('a3', 'other@example.com', 'migros'),
    ]);
    expect([...grouped.keys()].sort()).toEqual(['foo@example.com', 'other@example.com']);
    expect(grouped.get('foo@example.com')).toHaveLength(2);
  });

  it('drops address-less alerts instead of collapsing them into one bucket', () => {
    const grouped = groupAlertsByRecipient([
      alertDoc('a1', '', 'board-international'),
      alertDoc('a2', '   ', 'lidl'),
    ]);
    expect(grouped.size).toBe(0);
  });

  it('ranks sections freshest employer first — that is who headlines the subject', () => {
    // Deterministic ordering is not cosmetic: a retry after a failed send must
    // compose the identical email, or the card budget cuts somewhere else and
    // a DIFFERENT set of jobs goes out under the same dedup assumptions.
    const alerts = [
      alertDoc('old', 'a@b.ch', 'board-international'),
      alertDoc('new', 'a@b.ch', 'lidl'),
    ];
    const jobs = [jobDoc('j-old', 'Board International SA', 5), jobDoc('j-new', 'Lidl Schweiz AG', 1)];
    const sections = buildRecipientSections(alerts, jobs, NOW);
    expect(sections.map((s) => s.alert.id)).toEqual(['new', 'old']);
    expect(sections.map((s) => s.companyName)).toEqual(['Lidl Schweiz AG', 'Board International SA']);
  });

  it('gives every alert its OWN sentJobIds — grouping changes the email, not the dedup unit', () => {
    // "Already sent" is a property of the subscription, not of whichever
    // message happened to carry it. Two alerts of the same person must not
    // share a map, or unfollowing one would silently re-open the other.
    const alerts = [
      alertDoc('a1', 'a@b.ch', 'board-international', { sentJobIds: { 'j-board': NOW - 1000 } }),
      alertDoc('a2', 'a@b.ch', 'lidl'),
    ];
    const jobs = [jobDoc('j-board', 'Board International SA', 2), jobDoc('j-lidl', 'Lidl Schweiz AG', 1)];
    const sections = buildRecipientSections(alerts, jobs, NOW);
    // The Board alert's only match was already sent → no section at all, so it
    // is neither named in the subject nor marked again.
    expect(sections.map((s) => s.alert.id)).toEqual(['a2']);
    expect(sections[0].sentMap).toEqual({});
  });

  it('a section is dropped entirely when every match is already sent', () => {
    const alerts = [alertDoc('a1', 'a@b.ch', 'lidl', { sentJobIds: { 'j1': NOW - 1000 } })];
    expect(buildRecipientSections(alerts, [jobDoc('j1', 'Lidl Schweiz AG', 1)], NOW)).toEqual([]);
  });

  it('re-admits a job sent BEFORE the dedup window, like the digest does', () => {
    const alerts = [alertDoc('a1', 'a@b.ch', 'lidl', { sentJobIds: { 'j1': NOW - 40 * 24 * 3600_000 } })];
    const sections = buildRecipientSections(alerts, [jobDoc('j1', 'Lidl Schweiz AG', 1)], NOW);
    expect(sections).toHaveLength(1);
  });

  it('tolerates junk input instead of throwing mid-run', () => {
    expect(groupAlertsByRecipient(undefined as unknown as object[]).size).toBe(0);
    expect(buildRecipientSections(undefined as unknown as object[], [], NOW)).toEqual([]);
    expect(buildRecipientSections([alertDoc('a1', 'a@b.ch', 'lidl')], undefined as unknown as object[], NOW)).toEqual([]);
  });
});

describe('the grouped email: one message, a section per employer (residuo #5283)', () => {
  const sectionFor = (alertId: string, company: string, slug: string, jobs: object[]) => ({
    alertId,
    companyName: company,
    companySlug: slug,
    jobs,
    unsubscribeUrl: `https://frontaliereticino.ch/disiscrivi-alert/?alertId=${alertId}&token=t`,
  });
  const buildMulti = (locale: string, count: number) => buildCompanyAlertEmail({
    sections: Array.from({ length: count }, (_, i) =>
      sectionFor(`a${i}`, `Azienda ${i}`, `azienda-${i}`, [jobDoc(`j${i}`, `Azienda ${i}`, i + 1)])),
    email: 'a@b.ch',
    locale,
    manageUrl: 'https://frontaliereticino.ch/aziende-seguite/',
    unsubscribeAllUrl: 'https://frontaliereticino.ch/disiscrivi-alert/?all=1',
  });

  it('the 1-section form is byte-identical to the pre-grouping mono email', () => {
    // The regression that would hurt most: following ONE employer is the common
    // case and «Nuova offerta presso X» is the strongest subject this template
    // has. Grouping must not touch it.
    const job = jobDoc('j1', 'Board International SA', 1);
    const shared = {
      email: 'a@b.ch',
      locale: 'it',
      manageUrl: 'https://frontaliereticino.ch/preferenze-newsletter/',
      unsubscribeAllUrl: 'https://frontaliereticino.ch/disiscrivi-alert/?all=1',
    };
    const legacy = buildCompanyAlertEmail({
      ...shared,
      companyName: 'Board International SA',
      companySlug: 'board-international',
      jobs: [job],
      unsubscribeUrl: 'https://frontaliereticino.ch/disiscrivi-alert/?x=1',
    });
    const grouped = buildCompanyAlertEmail({
      ...shared,
      sections: [{
        alertId: 'a1',
        companyName: 'Board International SA',
        companySlug: 'board-international',
        jobs: [job],
        unsubscribeUrl: 'https://frontaliereticino.ch/disiscrivi-alert/?x=1',
      }],
    });
    expect(grouped.subject).toBe(legacy.subject);
    expect(grouped.html).toBe(legacy.html);
    expect(grouped.text).toBe(legacy.text);
  });

  it('names BOTH employers when there are two — the name is what gets it opened', () => {
    const { subject } = buildMulti('it', 2);
    expect(subject).toBe('Azienda 0 e Azienda 1: 2 nuove offerte');
    expect(buildMulti('en', 2).subject).toBe('Azienda 0 and Azienda 1: 2 new jobs');
    expect(buildMulti('de', 2).subject).toBe('Azienda 0 und Azienda 1: 2 neue Stellen');
    expect(buildMulti('fr', 2).subject).toBe('Azienda 0 et Azienda 1 : 2 nouvelles offres');
  });

  it('keeps the freshest employer in front and counts the rest, from three up', () => {
    // Never a bare number: «5 nuove offerte» names nobody and reads like a
    // newsletter, which is exactly what the dedicated template exists not to be.
    expect(buildMulti('it', 4).subject).toBe('Azienda 0 e altre 3 aziende: 4 nuove offerte');
    expect(buildMulti('en', 4).subject).toBe('Azienda 0 and 3 more companies: 4 new jobs');
    expect(buildMulti('de', 4).subject).toBe('Azienda 0 und 3 weitere Unternehmen: 4 neue Stellen');
    expect(buildMulti('fr', 4).subject).toBe('Azienda 0 et 3 autres entreprises : 4 nouvelles offres');
  });

  it('counts what it RENDERS, never the match pool (#3798)', () => {
    // Three employers with 8 new jobs each = 24 matches, but the email carries
    // COMPANY_ALERT_MAX_TOTAL_CARDS at most, and the subject must say so.
    const built = buildCompanyAlertEmail({
      sections: ['a', 'b', 'c'].map((k, i) =>
        sectionFor(`alert-${k}`, `Azienda ${k}`, `azienda-${k}`,
          Array.from({ length: 8 }, (_, j) => jobDoc(`${k}${j}`, `Azienda ${k}`, i + 1)))),
      email: 'a@b.ch',
      locale: 'it',
      manageUrl: 'https://x/',
      unsubscribeAllUrl: 'https://x/?all=1',
    });
    const rendered = built.sections.reduce((n: number, s: { jobs: object[] }) => n + s.jobs.length, 0);
    expect(rendered).toBeLessThanOrEqual(COMPANY_ALERT_MAX_TOTAL_CARDS);
    expect(built.subject).toBe(`Azienda a e altre 2 aziende: ${rendered} nuove offerte`);
  });

  it('renders a header, its jobs and its own hub CTA for every employer', () => {
    const { html, text } = buildMulti('it', 3);
    for (let i = 0; i < 3; i += 1) {
      expect(html).toContain(`/aziende/azienda-${i}/`);
      expect(html).toContain(`Vedi tutte le offerte di Azienda ${i}`);
      expect(text).toContain(`Vedi tutte le offerte di Azienda ${i}`);
      expect(html).toContain(`Ruolo j${i}`);
    }
  });

  it('speaks in the plural once it covers more than one employer', () => {
    // The mono closer says «questa azienda». Left unchanged it would claim a
    // 4-employer email is about one — the same class of lie as the pre-#5012
    // «tutte le offerte» filter line.
    expect(buildMulti('it', 1).html).toContain('segui questa azienda');
    expect(buildMulti('it', 3).html).toContain('segui queste aziende');
    expect(buildMulti('it', 3).html).not.toContain('segui questa azienda');
  });

  it('ships all four locales with the same key set — no partial translation', () => {
    const itKeys = Object.keys(COMPANY_ALERT_STRINGS.it).sort();
    for (const loc of ['en', 'de', 'fr'] as const) {
      expect(Object.keys(COMPANY_ALERT_STRINGS[loc]).sort(), `${loc} drifted from it`).toEqual(itKeys);
    }
  });

  it('escapes employer names in the grouped form too', () => {
    const { html } = buildCompanyAlertEmail({
      sections: [
        sectionFor('a1', 'Bürgenstock Hotels & Resort', 'burgenstock-hotels-resort', [jobDoc('j1', 'X', 1)]),
        sectionFor('a2', 'Coop & Co', 'coop', [jobDoc('j2', 'Y', 2)]),
      ],
      email: 'a@b.ch',
      locale: 'it',
      manageUrl: 'https://x/',
      unsubscribeAllUrl: 'https://x/?all=1',
    });
    expect(html).toContain('Hotels &amp; Resort');
    expect(html).not.toContain('Hotels & Resort');
  });

  it('stays under Gmail\'s 102 KB clip in its worst shape', () => {
    // Gmail hides everything past ~102 KB behind «Visualizza messaggio
    // completo» — and what ends up down there is the unsubscribe footer. The
    // worst shape for the card budget is one card per section (most chrome per
    // card), with every URL carrying the autologin pair.
    const wrapUrl = (u: string) => `${u}${u.includes('?') ? '&' : '?'}ne=${'e'.repeat(44)}&ac=${'a'.repeat(32)}&utm_source=company_alert&utm_medium=email`;
    const built = buildCompanyAlertEmail({
      sections: Array.from({ length: COMPANY_ALERT_MAX_TOTAL_CARDS }, (_, i) => sectionFor(
        `alert-${i}`,
        'Ente Ospedaliero Cantonale',
        'eoc-ente-ospedaliero-cantonale',
        [jobDoc(`j${i}`, 'Ente Ospedaliero Cantonale', 1, 'Infermiere specializzato in cure intense (80-100%)')],
      )),
      email: 'nome.cognome.lungo@example-domain.com',
      locale: 'it',
      manageUrl: wrapUrl('https://frontaliereticino.ch/aziende-seguite/'),
      unsubscribeAllUrl: `https://frontaliereticino.ch/disiscrivi-alert/?email=x&token=${'c'.repeat(64)}`,
      wrapUrl,
    });
    expect(built.sections).toHaveLength(COMPANY_ALERT_MAX_TOTAL_CARDS);
    const bodyBytes = Buffer.byteLength(built.html) + Buffer.byteLength(built.text);
    // Measured ≈ 71 KB when this was written. The assertion is the clip itself,
    // so a template change is free to grow the email but not to hide the footer.
    expect(bodyBytes).toBeLessThan(102 * 1024);
  });
});

describe('the card budget: what the email may render (residuo #5283)', () => {
  const section = (name: string, jobs: number) => ({
    companyName: name,
    companySlug: name.toLowerCase(),
    jobs: Array.from({ length: jobs }, (_, i) => ({ id: `${name}-${i}` })),
  });

  it('caps ONE employer at COMPANY_ALERT_MAX_CARDS', () => {
    expect(allocateCompanyAlertCards([section('a', 30)])[0].jobs).toHaveLength(COMPANY_ALERT_MAX_CARDS);
  });

  it('drops sections past the total budget whole, never as empty headers', () => {
    // A section with no cards is a header advertising nothing.
    const out = allocateCompanyAlertCards(
      Array.from({ length: COMPANY_ALERT_MAX_TOTAL_CARDS + 5 }, (_, i) => section(`c${i}`, 1)),
    );
    expect(out).toHaveLength(COMPANY_ALERT_MAX_TOTAL_CARDS);
    expect(out.every((s: { jobs: object[] }) => s.jobs.length > 0)).toBe(true);
  });

  it('trims the fattest employer first, so nobody is starved out of the email', () => {
    // Naive "fill in order until full" would let the first, most prolific
    // employer eat the whole budget and silently drop the other three — who
    // would then be re-sent next run, i.e. a second email, i.e. the bug.
    const out = allocateCompanyAlertCards([section('a', 6), section('b', 6), section('c', 6), section('d', 6)]);
    expect(out).toHaveLength(4);
    expect(out.reduce((n: number, s: { jobs: object[] }) => n + s.jobs.length, 0)).toBe(COMPANY_ALERT_MAX_TOTAL_CARDS);
    expect(Math.min(...out.map((s: { jobs: object[] }) => s.jobs.length))).toBeGreaterThan(0);
    // Water-filling, not truncation: the sizes stay within one card of each other.
    const sizes = out.map((s: { jobs: object[] }) => s.jobs.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('is idempotent — running it on its own output changes nothing', () => {
    // The sender feeds candidates in and reads rendered sections back out; if
    // the two passes disagreed, "what was sent" and "what was marked sent"
    // would too.
    const once = allocateCompanyAlertCards([section('a', 9), section('b', 9), section('c', 9)]);
    expect(allocateCompanyAlertCards(once)).toEqual(once);
  });

  it('keeps the caller\'s ranking and passes extra fields through', () => {
    const out = allocateCompanyAlertCards([
      { ...section('b', 1), alertId: 'a-b' },
      { ...section('a', 1), alertId: 'a-a' },
    ]);
    expect(out.map((s) => s.alertId)).toEqual(['a-b', 'a-a']);
  });

  it('tolerates junk sections instead of emitting an empty email body', () => {
    expect(allocateCompanyAlertCards([])).toEqual([]);
    expect(allocateCompanyAlertCards(undefined as never)).toEqual([]);
    expect(allocateCompanyAlertCards([{ companyName: 'x', companySlug: 'x' }])).toEqual([]);
  });
});

describe('dedup survives grouping (residuo #5283, the non-negotiable)', () => {
  it('marks EVERY rendered section\'s alert, each with its own key set', () => {
    // The failure this forbids: an email covering three employers that only
    // remembers one of them, so the next run re-mails the other two.
    const alerts = [
      alertDoc('a1', 'a@b.ch', 'board-international'),
      alertDoc('a2', 'a@b.ch', 'lidl'),
      alertDoc('a3', 'a@b.ch', 'migros'),
    ];
    const jobs = [
      jobDoc('j-board', 'Board International SA', 3),
      jobDoc('j-lidl', 'Lidl Schweiz AG', 1),
      jobDoc('j-migros', 'Migros Ticino', 2),
    ];
    const sections = buildRecipientSections(alerts, jobs, NOW);
    const built = buildCompanyAlertEmail({
      sections: sections.map((s) => ({
        alertId: s.alert.id,
        companyName: s.companyName,
        companySlug: String(s.alert.specificCompanyKey),
        jobs: s.jobs,
        unsubscribeUrl: `https://x/?alertId=${s.alert.id}`,
      })),
      email: 'a@b.ch',
      locale: 'it',
      manageUrl: 'https://x/',
      unsubscribeAllUrl: 'https://x/?all=1',
    });

    expect(built.sections).toHaveLength(3);
    const byId = new Map(sections.map((s) => [s.alert.id, s]));
    for (const rendered of built.sections as unknown as Array<{ alertId: string; jobs: Array<{ id: string }> }>) {
      const source = byId.get(rendered.alertId)!;
      const nextMap = mergeSentJobs(source.sentMap, rendered.jobs, NOW);
      // Its own jobs, and ONLY its own: a shared map would mark a Lidl job as
      // already sent to the Board alert and hide it there forever.
      expect(Object.keys(nextMap).sort()).toEqual(rendered.jobs.map((j) => j.id).sort());
    }
  });

  it('never marks a section the card budget dropped', () => {
    // Overflow is deferred, not delivered. Marking it would be a job the reader
    // is told about exactly never.
    const alerts = Array.from({ length: COMPANY_ALERT_MAX_TOTAL_CARDS + 3 }, (_, i) =>
      alertDoc(`a${i}`, 'a@b.ch', `azienda-${i}`));
    const jobs = alerts.map((_, i) => jobDoc(`j${i}`, `Azienda ${i}`, i + 1));
    const sections = buildRecipientSections(alerts, jobs, NOW);
    expect(sections).toHaveLength(COMPANY_ALERT_MAX_TOTAL_CARDS + 3);

    const built = buildCompanyAlertEmail({
      sections: sections.map((s) => ({
        alertId: s.alert.id,
        companyName: s.companyName,
        companySlug: String(s.alert.specificCompanyKey),
        jobs: s.jobs,
        unsubscribeUrl: `https://x/?alertId=${s.alert.id}`,
      })),
      email: 'a@b.ch',
      locale: 'it',
      manageUrl: 'https://x/',
      unsubscribeAllUrl: 'https://x/?all=1',
    });
    const renderedIds = (built.sections as unknown as Array<{ alertId: string }>).map((s) => s.alertId);
    expect(renderedIds).toHaveLength(COMPANY_ALERT_MAX_TOTAL_CARDS);
    // The three deferred alerts keep their sentJobIds untouched, so the next
    // run — minutes away, this workflow is push-driven — finds them unsent
    // while the ones just mailed drop out. The order rotates by itself.
    const deferred = sections.filter((s) => !renderedIds.includes(s.alert.id));
    expect(deferred).toHaveLength(3);
    expect(deferred.every((s) => Object.keys(s.sentMap).length === 0)).toBe(true);
  });

  it('a hard failure blocks the WHOLE recipient — no half-marked email', () => {
    const emails = [{ to: 'ok@b.ch' }, { to: 'dead@b.ch' }];
    const persistable = selectPersistableSends(emails, [{ recipient: { email: 'DEAD@b.ch' } }]);
    expect(persistable.map((e) => e.to)).toEqual(['ok@b.ch']);
  });

  it('treats an AMBIGUOUS delivery as sent — the one case where not marking is worse', () => {
    // #4911: the provider accepted the message and then failed on the response,
    // so it may already be in the inbox. Re-sending it produces exactly the
    // duplicate this whole change exists to remove; the flag was added so
    // callers could tell "never sent" from "unknown, do not resend blindly".
    const persistable = selectPersistableSends(
      [{ to: 'maybe@b.ch' }],
      [{ recipient: { email: 'maybe@b.ch' }, ambiguousDelivery: true }],
    );
    expect(persistable.map((e) => e.to)).toEqual(['maybe@b.ch']);
  });

  it('persists everything when nothing failed, and nothing when everything did', () => {
    const emails = [{ to: 'a@b.ch' }, { to: 'c@d.ch' }];
    expect(selectPersistableSends(emails, [])).toHaveLength(2);
    expect(selectPersistableSends(emails, emails.map((e) => ({ recipient: { email: e.to } })))).toHaveLength(0);
  });

  it('one recipient\'s writeback always fits in ONE Firestore batch', () => {
    // commitInChunks assumes one op per item to keep its slice length a safe
    // bound on ops-per-batch; a grouped item adds one update per section. If
    // this arithmetic broke, a chunk boundary could split an email's employers
    // across two commits — half marked as sent, half re-mailed next run.
    expect(DEDUP_CHUNK_SIZE).toBeGreaterThan(0);
    expect(DEDUP_CHUNK_SIZE * COMPANY_ALERT_MAX_TOTAL_CARDS).toBeLessThanOrEqual(FIRESTORE_BATCH_SIZE);
  });
});

describe('unsubscribe in a grouped email (residuo #5283, RFC 8058)', () => {
  const sections = (n: number) => Array.from({ length: n }, (_, i) => ({
    alertId: `a${i}`,
    companyName: `Azienda ${i}`,
    companySlug: `azienda-${i}`,
    jobs: [jobDoc(`j${i}`, `Azienda ${i}`, i + 1)],
    unsubscribeUrl: `https://frontaliereticino.ch/disiscrivi-alert/?alertId=a${i}&token=tok${i}`,
  }));
  const ALL = 'https://frontaliereticino.ch/disiscrivi-alert/?email=x&token=tokall&action=unsubscribe_all';
  const build = (n: number) => buildCompanyAlertEmail({
    sections: sections(n),
    email: 'a@b.ch',
    locale: 'it',
    manageUrl: 'https://frontaliereticino.ch/aziende-seguite/',
    unsubscribeAllUrl: ALL,
  });

  /**
   * Every href the email renders, un-escaped back to the URL a click actually
   * sends. Substring-matching the raw html would silently pass on `&amp;`
   * (which is correct markup) and, worse, would pass on a URL that appears in
   * a `title=` or in prose rather than in a link somebody can click.
   */
  const renderedHrefs = (html: string) =>
    [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

  it('gives every employer its own per-alert link, in html AND text', () => {
    // Per-section AND global, not one or the other: the reader who wants out of
    // one employer must be able to say so, and both shapes are pure HMAC
    // (scripts/lib/job-alert-unsub-urls.mjs) so neither needs a session — the
    // property that makes an unsubscribe work from any mail client.
    const { html, text } = build(3);
    const hrefs = renderedHrefs(html);
    for (let i = 0; i < 3; i += 1) {
      expect(hrefs).toContain(sections(3)[i].unsubscribeUrl);
      expect(text).toContain(`Smetti di seguire Azienda ${i}`);
      expect(text).toContain(sections(3)[i].unsubscribeUrl);
    }
    expect(hrefs).toContain(ALL);
    expect(text).toContain(ALL);
  });

  it('the RFC 8058 header URL is ALWAYS one the body renders', () => {
    // The non-negotiable: a One-Click header pointing somewhere the reader
    // cannot also click is an unsubscribe nobody can verify — and the digest's
    // contract is that the two are the same URL.
    for (const n of [1, 2, 5]) {
      const built = build(n);
      const header = pickOneClickUnsubscribeUrl(built.sections, ALL);
      expect(renderedHrefs(built.html), `${n} section(s): header URL is not a link in the body`).toContain(header);
      expect(built.text, `${n} section(s): header URL missing from text`).toContain(header);
    }
  });

  it('one-click means the per-alert link when the email covers ONE employer', () => {
    // Unchanged from before grouping, and the narrowest action that honours the
    // click: it leaves the reader's keyword alerts alone.
    expect(pickOneClickUnsubscribeUrl(build(1).sections, ALL)).toBe(sections(1)[0].unsubscribeUrl);
  });

  it('one-click means ALL alerts when the email covers several', () => {
    // Unfollowing an arbitrary one of five would not stop the message: the next
    // run mails the other four, the Unsubscribe button looks broken, and that is
    // how a mailbox provider learns to file this sender under spam.
    expect(pickOneClickUnsubscribeUrl(build(5).sections, ALL)).toBe(ALL);
  });

  it('falls back to the global link rather than emitting an empty header', () => {
    expect(pickOneClickUnsubscribeUrl([{ }], ALL)).toBe(ALL);
    expect(pickOneClickUnsubscribeUrl(undefined as never, ALL)).toBe(ALL);
  });
});

describe('the follow cap, after grouping (residuo #5283)', () => {
  it('is pinned to the email\'s card budget, so a follow set always fits in ONE email', () => {
    // The old 10 was never about how many employers a person may follow: it was
    // a deliverability brake, because the sender mailed one email per alert per
    // run. Grouping makes the per-inbox ceiling 1 message whatever this number
    // says, so the brake had nothing left to brake — and the number that
    // replaces it is the one the message can actually carry.
    expect(MAX_COMPANY_ALERTS_PER_USER).toBe(COMPANY_ALERT_MAX_TOTAL_CARDS);
    expect(MAX_COMPANY_ALERTS_PER_USER).toBeGreaterThan(MAX_ALERTS_PER_USER);
  });

  it('the sender no longer sends one email per alert', () => {
    // Structural, and worth pinning: the loop iterates recipients. Reverting to
    // an alert loop would restore the ten-emails-in-one-inbox defect with every
    // unit test above still green, because they test the pieces, not the walk.
    const sender = readRepoFile('scripts/send-company-alerts.mjs');
    expect(sender).toContain('groupAlertsByRecipient(alerts)');
    expect(sender).toContain('buildRecipientSections(alertsByRecipient.get(recipient)');
    expect(sender).toContain('for (let i = 0; i < recipients.length; i += 1)');
    expect(sender.includes('for (const alert of alerts) {')).toBe(false);
    // PER_RUN_CAP now counts recipients — the unit changed even though the
    // number did not, and the log line must not keep saying "emails".
    expect(sender).toContain('PER_RUN_CAP} recipients) reached');
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
