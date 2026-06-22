#!/usr/bin/env node
/**
 * Crawler health checker.
 *
 * Reads `data/jobs/by-crawler/{slug}.json` for jobCount + fallback freshness,
 * and `data/jobs-crawler-summaries/by-crawler/{slug}.json` for the PRIMARY
 * freshness signal. Derives per-crawler health, updates
 * `data/crawler-health.json` (running state), and writes
 * `data/crawler-health-issues.json` if any crawler is stale/broken.
 *
 * Exit code:
 *   0 — all crawlers healthy (or no crawlers at all)
 *   1 — one or more crawlers stale/broken (workflow will open issues)
 *
 * Safe to run multiple times per day. Does NOT throw on individual crawler
 * read errors — logs and continues.
 *
 * Freshness signal — TWO-TIER:
 *
 *   1. PRIMARY: `generatedAt` from the summary slice
 *      (`data/jobs-crawler-summaries/by-crawler/{slug}.json`). The summary is
 *      written on EVERY crawler run, including runs that found zero listings
 *      and took the "Keeping existing" branch (~42 crawlers do this). The
 *      summary is therefore the only reliable "the workflow ran today" proof.
 *
 *   2. FALLBACK: `assembledAt` from the by-crawler slice
 *      (`data/jobs/by-crawler/{slug}.json`) — only updated when the slice
 *      itself is rewritten, so it freezes for weeks on "Keeping existing"
 *      runs. Used only when no summary slice exists yet.
 *
 * Both timestamps are slice-self-reported (not fs.stat mtime), because mtime
 * is unreliable on CI checkouts (always equals checkout time).
 *
 * Status transitions:
 *   - healthy           → summary fresh (<= 7d) AND (jobs > 0 OR low empty streak)
 *   - broken            → 3+ consecutive empty observations (legitimately
 *                         empty source like BancaStato won't cross this gate
 *                         because the daily monitor records the same fresh
 *                         summary repeatedly — see consecutiveEmptyRuns logic)
 *   - stale             → summary `generatedAt` older than 7d (or fallback
 *                         `assembledAt` older than 7d when no summary exists)
 *   - warming_up        → never observed before, freshness OK, and empty
 *                         (do NOT flag — wait until we have history)
 *
 * Follow-up (not in this script): adding `lastFetchOutcome` to each summary
 * slice — values like "ok" / "anti_bot_block" / "selector_miss" /
 * "filtered_empty" — would let the monitor distinguish a fetch failure from
 * a legitimately empty source on the FIRST observation, rather than waiting
 * 3 days for the empty-streak gate.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const SUMMARIES_DIR = path.join(
  ROOT,
  'data',
  'jobs-crawler-summaries',
  'by-crawler',
);
const HEALTH_STATE_PATH = path.join(ROOT, 'data', 'crawler-health.json');
const HEALTH_ISSUES_PATH = path.join(ROOT, 'data', 'crawler-health-issues.json');

const STALE_AFTER_DAYS = 7;
const BROKEN_AFTER_EMPTY_RUNS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EMPTY_OK_CRAWLERS = new Set([
  // Current source page explicitly reports no open offers; a fresh successful
  // crawl is the useful health signal.
  'csvp-poschiavo',
  // Dedicated regional Zurich Insurance search can legitimately return zero
  // TI/GR openings while the crawler and source are healthy.
  'zurich-insurance-sede-ticino',
  // Manor sitemap currently lists 160+ jobs across CH but none in Ticino
  // (Lugano/Locarno/Biasca). Manor has effectively withdrawn from TI hiring
  // for now; parser is healthy and will re-arm when TI listings reappear.
  'manor',
  // Zambon Cadempino (TI) production site: the ncoreplat careers API
  // (https://www.zambon.com/it/api/careers-api) returns jobs across
  // BR/DE/IT/FR/ES/CO but currently 0 CH listings. Parser is healthy.
  'zambon',
  // AIL Lugano: the AJAX endpoint
  // (https://www.ail.ch/AIL/risorse-umane/offerte-di-lavoro/content/0.html?ajax=true)
  // currently returns HTTP 200 with "Al momento non ci sono posizioni aperte".
  // Zero open positions is a legitimate state; the parser is healthy and
  // re-arms when AIL publishes openings again.
  'ail-lugano',
  // Città di Locarno: the careers page
  // (https://www.locarno.ch/it/albo-comunale/assunzioni-personale) currently
  // shows "Assunzioni personale (0) — Nessun documento trovato". The
  // municipality has no active public competitions right now; parser is healthy.
  'citta-di-locarno',
  // ALTEN Switzerland: the crawler is scoped to TI/GR openings only
  // (https://www.alten.ch/career/jobs/). The consultancy currently lists no
  // Ticino/Graubünden roles; same legitimately-empty regional-filter case as
  // zurich-insurance-sede-ticino and manor. Parser is healthy.
  'alten-switzerland',
  // The Living Circle: the feed (https://jobs.thelivingcircle.ch/jobs.feed.json)
  // currently returns 13 open jobs CH-wide but 0 in Ticino. The luxury-hotel
  // group hires mostly in ZH/GR/VS; the crawler is scoped to TI and is healthy
  // — same legitimately-empty regional-filter case as manor and alten-switzerland.
  // Re-arms when a TI listing appears.
  'the-living-circle',
  // Banca Raiffeisen Vedeggio-Cassarate: the single regional bank's careers page
  // (https://www.raiffeisen.ch/vedeggio-cassarate/it/chi-siamo/carriera/lavorare-banca-raiffeisen.html)
  // returns HTTP 200 with 0 open positions ("Offerte attive: 0"). A small local
  // cooperative bank legitimately has no openings for weeks at a time; the
  // crawler completes cleanly and re-arms when a vacancy is published.
  'banca-raiffeisen-vedeggio-cassarate',
  // Linnea SA (Riazzino, TI): the careers page (https://www.linnea.ch/careers/)
  // returns HTTP 200 and explicitly states "No open positions at this time."
  // The parser correctly finds 0 accordion items; the botanical-ingredients
  // manufacturer simply has no current openings. Healthy, re-arms when a
  // vacancy is published.
  'linnea',
  // Clinique CIC (Saxon VS & Clarens VD): the jobup.ch company mask
  // (https://www.jobup.ch/masks/clinique-cic/list_clinique-cic.asp) returns
  // HTTP 200 with its unchanged structure but currently only the two
  // "Offres spontanées" placeholder rows (one per clinic), which the parser
  // correctly drops as non-openings. A small two-site private surgical group
  // legitimately has 0 real vacancies for stretches (had 2 on 2026-06-16); the
  // listing parser is healthy and re-arms when a real opening reappears. Same
  // legitimately-empty small-employer case as linnea and
  // banca-raiffeisen-vedeggio-cassarate.
  'clinique-cic',
  // Giorgio Armani S.p.A. (SuccessFactors SPA, company=3397177P): the dedicated
  // crawler renders the hydrated listing (~34 jobs) correctly and is scoped to
  // Switzerland-based roles only (TI/GR). The Italian luxury house posts almost
  // exclusively Italy roles; Swiss openings are sporadic boutique/outlet spots
  // (history: Armani Outlet Mendrisio req 5074, expired 2026-06-08). The listing
  // parser + Swiss filter are healthy — they discover the full listing and
  // correctly classify all current rows as non-Swiss. Same legitimately-empty
  // regional-filter case as manor/alten-switzerland/fusalp/bracco. Re-arms when
  // a CH listing reappears.
  'giorgio-armani',
  // Fusalp (French apparel brand, WelcomeKit portal https://fusalp.welcomekit.co):
  // the crawler is scoped to Swiss roles only and skips France/EU listings.
  // Fusalp posts mostly French jobs (Annecy HQ, Lyon/Paris/Nice boutiques) with
  // only occasional Swiss boutique openings (history: Aubonne VD, Crans-Montana
  // VS). The listing parser is healthy — it finds the 6 live listings and
  // correctly filters them as non-Swiss; same legitimately-empty regional-filter
  // case as manor and alten-switzerland. Re-arms when a CH listing appears.
  'fusalp',
  // Bracco Suisse S.A.: the Workday API (bracco.wd103.myworkdayjobs.com) returns
  // 100+ jobs globally but only sporadic openings at the two Swiss sites the
  // crawler is scoped to (Cadempino TI + Plan-les-Ouates GE). The crawler fetches
  // every posting and keeps Swiss ones by location text (no brittle location
  // UUIDs). A small medical-imaging subsidiary legitimately has no Swiss openings
  // for weeks; parser is healthy and re-arms when a CH role appears. Same
  // regional-filter case as manor/alten-switzerland.
  'bracco',
  // FNZ (Switzerland) AG: the Workday API (fnz.wd3.myworkdayjobs.com) lists
  // ~120 jobs globally (UK/Czechia/India/Ireland…) but only sporadic Swiss roles
  // at Chiasso (TI) / Geneva (GE). The crawler now fetches every posting and
  // keeps Swiss ones by location text (no brittle location UUIDs — the old
  // hardcoded city facet IDs silently rotted to total:0, the original break).
  // Zero Swiss openings is a legitimate state; parser is healthy and re-arms when
  // a CH role appears. Same regional-filter case as manor/bracco.
  'fnz',
  // International School of Ticino (jobs.inspirededu.com, Inspired Education
  // group): the crawler discovers postings via the group sitemap and keeps only
  // those whose city maps to IST cantons (TI/GR). The group posts campus jobs
  // worldwide; IST Lugano/Chur openings are sporadic. Zero live TI/GR positions
  // is a legitimate state (verified: the TalentBrew search returns "no open
  // positions match" for Lugano/Chur); parser is healthy and re-arms when an IST
  // role appears. Same legitimately-empty regional-filter case as manor/fusalp.
  'international-school-of-ticino',
  // Schweizer Paraplegiker-Gruppe (Umantis tenant 2782) and Universitäre
  // Psychiatrische Dienste Bern / UPD (Umantis tenant 2908): both listing
  // endpoints (/Jobs/All) still return ~10 jobs, but the per-job detail URLs
  // (/Vacancies/{id}/Description/*) now 3xx-redirect cross-host — the tenants
  // migrated their job descriptions off Umantis (issue #1245). The shared
  // umantis parser correctly QUARANTINES every dead-detail job (it refuses to
  // synthesise boilerplate that would trip the dataset boilerplate-guard) and
  // emits 0 — the accepted degraded state for a migrated source, NOT a parser
  // break. Re-arms automatically if the tenant restores Umantis detail pages.
  // Real fix (per-tenant public-site description extraction) is deferred in
  // #1245 as fragile/per-tenant.
  'paraplegie',
  'upd',
  // Würth International (Chur, GR): the careers listing
  // (https://www.wurth-international.com/web/en/wurthinternational/jobs_career/jobs/Jobs.php)
  // returns HTTP 200 with its unchanged structure but currently shows "Keine
  // Stellen" (no positions) and zero job-detail links. The Würth holding's Chur
  // HQ legitimately has stretches with no open roles; the parser correctly
  // returns 0 and re-arms when a vacancy reappears. Same legitimately-empty
  // small-employer case as linnea and banca-raiffeisen-vedeggio-cassarate.
  'wuerth-international',
  // Suchtfachstelle Zürich: the careers page
  // (https://www.suchtfachstelle.zuerich/ueber-uns/offene-stellen) returns
  // HTTP 200 with the employer section intact but currently lists zero
  // "/stellenausschreibung-*" openings. A single addiction-counselling NGO
  // legitimately has no vacancies for weeks; the parser/regex is healthy and
  // re-arms when an opening is published.
  'suchtfachstelle-zuerich',
  // Clinica Moncucco (Lugano, TI): the careers page
  // (https://www.moncucco.ch/lavora-con-noi.php) returns HTTP 200 and its
  // ".listing-job" container explicitly states "Nessun annuncio presente al
  // momento" with zero ".item-job" children. The hospital legitimately has no
  // open competitions right now; the selector is healthy and re-arms when a
  // listing reappears.
  'moncucco',
]);

/** Read JSON file, return null on any error. */
async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** List `*.json` files in by-crawler dir, return slugs. */
async function listCrawlerSlugs() {
  try {
    const entries = await fs.readdir(BY_CRAWLER_DIR);
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/, ''))
      .sort();
  } catch (err) {
    console.error(`[health] Cannot read ${BY_CRAWLER_DIR}: ${err.message}`);
    return [];
  }
}

/**
 * Inspect one crawler and return derived facts.
 *
 * Reads:
 *   - `data/jobs/by-crawler/{slug}.json`            → activeJobCount + fallback timestamp
 *   - `data/jobs-crawler-summaries/by-crawler/{slug}.json` → primary timestamp
 *
 * Returns null if the by-crawler slice cannot be read/parsed (caller logs +
 * skips). The summary slice is optional — when missing we fall back to
 * `assembledAt`.
 *
 * Returns `{ slug, freshnessAt, freshnessSource, assembledAt, generatedAt,
 * jobCount, activeJobCount }`:
 *   - `freshnessAt` is the timestamp the stale gate compares against
 *     (summary `generatedAt` when present, otherwise by-crawler `assembledAt`).
 *   - `freshnessSource` is `'summary' | 'by-crawler' | 'mtime' | 'none'`.
 */
async function inspectCrawler(slug) {
  const sliceFilePath = path.join(BY_CRAWLER_DIR, `${slug}.json`);
  const data = await readJsonSafe(sliceFilePath);
  if (data === null) {
    console.warn(`[health] ${slug}: cannot read/parse slice; skipping`);
    return null;
  }

  // Tolerate any shape: array of jobs OR { jobs: [...] } OR { entries: [...] }.
  let activeJobCount = 0;
  if (Array.isArray(data)) {
    activeJobCount = data.length;
  } else if (data && Array.isArray(data.jobs)) {
    activeJobCount = data.jobs.length;
  } else if (data && Array.isArray(data.entries)) {
    activeJobCount = data.entries.length;
  } else if (data && typeof data === 'object') {
    // Best-effort: count any array property at the top level.
    for (const v of Object.values(data)) {
      if (Array.isArray(v) && v.length > activeJobCount) activeJobCount = v.length;
    }
  }

  // Slice shape is `{ crawlerKey, assembledAt, jobs }`. The by-crawler
  // `assembledAt` is only updated when the slice itself is rewritten — it
  // freezes for weeks on "Keeping existing" runs.
  let assembledAt =
    data && typeof data === 'object' && typeof data.assembledAt === 'string'
      ? data.assembledAt
      : null;

  if (!assembledAt) {
    try {
      const stat = await fs.stat(sliceFilePath);
      assembledAt = stat.mtime.toISOString();
    } catch {
      assembledAt = null;
    }
  }

  // PRIMARY freshness signal: summary slice's `generatedAt`. Written on every
  // crawler run, including "found 0, keeping existing" runs.
  const summaryFilePath = path.join(SUMMARIES_DIR, `${slug}.json`);
  const summary = await readJsonSafe(summaryFilePath);
  const generatedAt =
    summary && typeof summary === 'object' && typeof summary.generatedAt === 'string'
      ? summary.generatedAt
      : null;
  const summaryTotal =
    summary && typeof summary === 'object' && Number.isFinite(Number(summary.total))
      ? Number(summary.total)
      : null;
  // For crawler health, count what the crawler found, not what later
  // housekeeping kept in the active slice. URL cleanup has its own failure
  // surface; otherwise a cleanup false positive is mislabeled as a parser
  // returning zero jobs.
  const jobCount = summaryTotal ?? activeJobCount;

  let freshnessAt;
  let freshnessSource;
  if (generatedAt) {
    freshnessAt = generatedAt;
    freshnessSource = 'summary';
  } else if (assembledAt) {
    freshnessAt = assembledAt;
    // If we used fs.stat above the field name is approximate but the source
    // is still the by-crawler slice (or its mtime); flag distinctly for logs.
    freshnessSource =
      data && typeof data === 'object' && typeof data.assembledAt === 'string'
        ? 'by-crawler'
        : 'mtime';
  } else {
    freshnessAt = null;
    freshnessSource = 'none';
  }

  return {
    slug,
    freshnessAt,
    freshnessSource,
    assembledAt,
    generatedAt,
    jobCount,
    activeJobCount,
  };
}

/**
 * Compose new state for a crawler, given previous state + new observation.
 *
 * Status priority (first match wins):
 *   1. `freshnessAt` older than 7d → "stale" (regardless of streak)
 *   2. 3+ consecutive empty observations → "broken"
 *   3. fresh + empty + no prior non-zero ever → "warming_up" (do NOT flag)
 *   4. otherwise → "healthy"
 *
 * `freshnessAt` is the summary slice's `generatedAt` when present, otherwise
 * the by-crawler slice's `assembledAt`. See `inspectCrawler` for details.
 */
function nextCrawlerState(prev, observation, nowIso, nowMs) {
  const previous = prev && typeof prev === 'object' ? prev : {};
  const hadPriorState = Boolean(prev);
  const lastObservedJobs = observation.jobCount;

  const emptyOk = EMPTY_OK_CRAWLERS.has(observation.slug);
  const consecutiveEmptyRuns =
    lastObservedJobs > 0 || emptyOk ? 0 : (previous.consecutiveEmptyRuns ?? 0) + 1;

  const lastNonZeroJobs =
    lastObservedJobs > 0 ? lastObservedJobs : (previous.lastNonZeroJobs ?? 0);

  // Back-compat: legacy callers (older tests) pass `{ assembledAt, jobCount }`
  // directly. Resolve a freshness timestamp from whichever field is present.
  const freshnessAt =
    observation.freshnessAt !== undefined
      ? observation.freshnessAt
      : (observation.assembledAt ?? null);
  const freshnessSource = observation.freshnessSource ?? 'by-crawler';

  // "Successful" = slice carries non-zero jobs. We use the freshness timestamp
  // (summary preferred, by-crawler fallback) so the value survives CI
  // checkouts cleanly.
  const lastSuccessfulRunAt =
    lastObservedJobs > 0
      ? freshnessAt
      : (previous.lastSuccessfulRunAt ?? null);

  // Freshness derives from the summary slice (or the by-crawler fallback when
  // no summary exists yet), NOT from `lastSuccessfulRunAt`. A source like
  // BancaStato may legitimately be empty for weeks — the summary slice is
  // still being refreshed daily, so the crawler is working. Only flag stale
  // when the workflow itself stops running.
  const freshnessAgeMs =
    freshnessAt !== null && freshnessAt !== undefined
      ? nowMs - new Date(freshnessAt).getTime()
      : Infinity;
  const freshnessAgeDays = freshnessAgeMs / MS_PER_DAY;

  let status = 'healthy';
  let reason = null;
  if (freshnessAgeDays > STALE_AFTER_DAYS) {
    status = 'stale';
    reason = `crawler not run in ${Math.round(freshnessAgeDays)} days (freshnessAt=${freshnessAt ?? 'unknown'}, source=${freshnessSource})`;
  } else if (lastObservedJobs === 0 && emptyOk) {
    status = 'healthy';
    reason = null;
  } else if (consecutiveEmptyRuns >= BROKEN_AFTER_EMPTY_RUNS) {
    status = 'broken';
    reason = `${consecutiveEmptyRuns} consecutive runs returned 0 jobs`;
  } else if (lastObservedJobs === 0 && !lastSuccessfulRunAt && !hadPriorState) {
    // First time we see this crawler AND it's empty AND we have no history.
    // We can't tell yet if this is a legitimately-empty source (BancaStato)
    // or a freshly-broken parser. Wait for the empty-streak gate to catch
    // genuinely broken parsers — they'll fail 3 days in a row.
    status = 'warming_up';
    reason = null;
  }

  return {
    state: {
      lastSuccessfulRunAt,
      lastNonZeroJobs,
      consecutiveEmptyRuns,
      lastFailureReason: reason,
      status,
      _lastObservedAt: nowIso,
      _lastObservedJobs: lastObservedJobs,
      _lastObservedFreshnessAt: freshnessAt,
      _lastObservedFreshnessSource: freshnessSource,
      _lastObservedAssembledAt: observation.assembledAt ?? null,
      _lastObservedGeneratedAt: observation.generatedAt ?? null,
    },
    reason,
    status,
  };
}

async function main() {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const slugs = await listCrawlerSlugs();
  if (slugs.length === 0) {
    console.warn('[health] No crawler files found; nothing to check.');
  }

  const prevState = (await readJsonSafe(HEALTH_STATE_PATH)) ?? {
    _lastCheckedAt: null,
    crawlers: {},
  };
  const prevCrawlers = prevState.crawlers ?? {};

  const nextCrawlers = {};
  const issues = [];

  for (const slug of slugs) {
    const observation = await inspectCrawler(slug);
    if (!observation) continue; // Skipped — already logged.

    const { state, status, reason } = nextCrawlerState(
      prevCrawlers[slug],
      observation,
      nowIso,
      nowMs,
    );
    nextCrawlers[slug] = state;

    if (status === 'stale' || status === 'broken') {
      issues.push({
        slug,
        reason: reason ?? `status=${status}`,
        lastSeenAt: state.lastSuccessfulRunAt,
        status,
        consecutiveEmptyRuns: state.consecutiveEmptyRuns,
      });
    }
  }

  // Carry forward any previously-tracked crawlers that disappeared from disk
  // (e.g. crawler renamed) so we don't lose their history silently.
  for (const [slug, prev] of Object.entries(prevCrawlers)) {
    if (!(slug in nextCrawlers)) {
      nextCrawlers[slug] = { ...prev, status: 'unknown', _missingAt: nowIso };
    }
  }

  const nextState = {
    _lastCheckedAt: nowIso,
    crawlers: nextCrawlers,
  };

  await fs.writeFile(HEALTH_STATE_PATH, JSON.stringify(nextState, null, 2) + '\n');

  if (issues.length > 0) {
    await fs.writeFile(HEALTH_ISSUES_PATH, JSON.stringify(issues, null, 2) + '\n');
    console.error(
      `[health] ${issues.length} crawler(s) stale/broken:`,
      issues.map((i) => `${i.slug}(${i.status})`).join(', '),
    );
    process.exit(1);
  }

  // Clear the stale issues file if it exists from a prior run — nothing to flag.
  try {
    await fs.unlink(HEALTH_ISSUES_PATH);
  } catch {
    /* file did not exist */
  }

  console.log(`[health] All ${slugs.length} crawler(s) healthy.`);
  process.exit(0);
}

// Exported for tests. `main()` only runs when the script is invoked directly.
export { nextCrawlerState, inspectCrawler };

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
      import.meta.url.endsWith(path.basename(process.argv[1] || ''));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error('[health] Fatal error:', err);
    process.exit(2);
  });
}