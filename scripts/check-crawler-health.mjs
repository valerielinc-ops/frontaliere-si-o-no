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
  // Città di Mendrisio: the concorsi page
  // (https://mendrisio.ch/home/lavorare/lavorare-per-la-citta/concorsi-di-lavoro.html)
  // loads its openings via the AJAX endpoint
  // (.../concorsi-di-lavoro/content/04.html?ajax=true), which currently returns
  // HTTP 200 with an empty "<div></div>" (no <article class="document"> blocks).
  // The only recent listing ("Presidente aggiunto", deadline 2026-06-26) expired
  // and was removed from the source, so the municipality has 0 open public
  // competitions right now. The AJAX URL is unchanged and the parser last
  // extracted a job on 2026-06-25, so it is healthy and re-arms when a new
  // concorso is published. Same legitimately-empty Ticino-municipality case as
  // citta-di-locarno and csvp-poschiavo.
  'citta-di-mendrisio',
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
  // Psychiatriezentrum Münsingen (PZM, Prospective medium 1008606): the
  // public career site (pzmag.ch/karriere) now 301-redirects to
  // upz-bern.ch/karriere — PZM merged with UPD Bern into "Universitäres
  // Psychiatrisches Zentrum Bern (UPZ)" (verified live 2026-07-11). The
  // shared Prospective API is still live (71 postings on medium 1008606),
  // but every listing's `links.directlink` now resolves to the generic
  // `ohws.prospective.ch/public/v1/jobs/{id}` job-direct format instead of
  // the `jobs.pzmag.ch` host this parser's `acceptDirectlinkHosts`
  // allowlist requires — so 0 is the correct, permanent output for this
  // companyKey, not a selector break. The former PZM roles (verified: e.g.
  // "Dipl. Pflegefachperson im Nachtdienst ICM", Hunzigenallee 1
  // Münsingen) are already surfaced by the sibling `upd` crawler above
  // (Umantis tenant 2908), which now lists the full merged UPZ vacancy set
  // including Münsingen-located roles — so no coverage is lost. Retiring
  // the dedicated crawler (removing it from `.github/workflows/
  // crawler-group-10.yml`) is the complete follow-up but out of reach for
  // the automated fixer (no `workflows` push scope); tracked in #4080.
  'pzm-muensingen',
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
  // Impresa Pizzarotti & C. S.p.A. (Parma-based construction group): the
  // dedicated crawler parses the InRecruiting/Intervieweb listing
  // (https://inrecruiting.intervieweb.it/app.php?module=iframeAnnunci&k=4b540470d86438622d22d56b1b3e761a&LAC=impresapizzarotti&typeView=large)
  // and keeps ONLY Swiss-located vacancies. The endpoint returns HTTP 200 with
  // ~14 live `div.vacancy__render` cards (parser healthy — it discovers them
  // all), but they are currently all Italy roles (Parma, Ponte Taro, Calabria,
  // Baragiano…) and zero Switzerland. The Italian builder posts Swiss roles only
  // sporadically on its cross-border projects (history: Le Locle NE chef de
  // contrôle de projet; Project Control Manager Svizzera req 659346). The listing
  // parser + Swiss filter are healthy — they fetch every posting and correctly
  // classify all current rows as non-Swiss. Same legitimately-empty
  // regional-filter case as giorgio-armani/bracco/fnz/manor/alten-switzerland.
  // Re-arms when a CH listing reappears.
  'impresa-pizzarotti',
  // DXT Commodities S.A. (Lugano, TI): the WordPress + WPSM accordion careers
  // page (https://dxt.com/careers/) returns HTTP 200 with the full ~370 KB
  // rendered page (166 panels) for the crawler's default desktop UA, but every
  // location group (London, Lugano, Singapore, Stamford) currently holds a
  // single placeholder panel reading "There are no open positions at the
  // moment. Please check back." The energy/commodity trader (Duferco Group)
  // legitimately has no Lugano openings right now; the WPSM parser correctly
  // skips the no-positions placeholders and re-arms when a vacancy is
  // published. Same legitimately-empty small-employer case as linnea and
  // banca-raiffeisen-vedeggio-cassarate.
  'dxt-commodities',
  // A++ Group (a2plus, Massagno TI): the dedicated crawler parses the
  // InRecruiting listing (https://inrecruiting.intervieweb.it/a2plus/en/career)
  // via `div.vacancy__render` cards — the same selector that still works for
  // other InRecruiting tenants (impresa-pizzarotti). Both the server-rendered
  // page and the underlying AJAX listing endpoint
  // (module=newcareer&ajax=1, act1=vacancyListCareer) currently return
  // "No vacancies available" company-wide (not just for Swiss-filtered
  // roles) — the architecture/design firm has 0 open positions right now.
  // The parser is healthy and re-arms when a vacancy is published (#3198).
  'a-group',
  // Medics Labor AG (Bern): the Refline listing
  // (https://app.reflinejobs.io/1474/positions.html?lang=de) returns HTTP 200
  // with the unchanged anchor-list template, but the page now explicitly
  // renders `<div class="searchPageNoResult">Zurzeit haben wir keine
  // Vakanzen.</div>` (checked de/en/fr/it — same empty state on every
  // locale) and the public medics.ch careers page
  // (/ueber-uns/jobs-und-ausbildung/offene-stellen) lists no openings either.
  // The medical-diagnostics lab legitimately has 0 open positions right now;
  // the parser is healthy (still discovers the listing, still recognises the
  // no-result markup) and re-arms when a vacancy is published. Same
  // legitimately-empty small-employer case as linnea and
  // banca-raiffeisen-vedeggio-cassarate (#3344).
  // Medics Labor AG (Bern, Refline tenant 1474): the listing page
  // with the unchanged anchor-list structure and explicitly states "Zurzeit
  // haben wir keine Vakanzen. Schauen Sie gerne später wieder bei uns vorbei."
  // (currently no vacancies). The small private lab (2 open roles as of
  // 2026-06-29) legitimately went to 0 openings; the shared Refline parser
  // (`refline-common.mjs`) is healthy and re-arms when a new posting appears.
  // Same legitimately-empty small-employer case as linnea and
  // wuerth-international (#3344).
  'medics-labor',
  // AXA Svizzera (Prospective.ch Career Center 2193, national CH-wide
  // crawler): the listing (https://jobs.axa.ch/?lang=it&offset=0&limit=500)
  // returns HTTP 200 with the unchanged filter form and `#jobs-list`
  // structure (same ids/classes the parser targets), but the server now
  // renders `<p id="no-results">Attualmente non sono disponibili posti
  // vacanti con questi criteri.</p>` and zero `<a id="job-*">` anchors — same
  // across it/de/fr/en and confirmed in the production crawl log (issue
  // #3564, 2026-07-05). Individual detail pages return HTTP 410 ("La
  // pubblicazione di questo posto di lavoro è terminata"), proving the ATS
  // backend is live and simply has no current national openings, not a
  // template/markup change. Job count declined gradually (153 → 0) over
  // ~3 weeks as postings expired without replacements, consistent with a
  // real hiring lull, not a selector break. Parser is healthy and re-arms
  // automatically when AXA republishes openings.
  'axa-svizzera',
  // Browser-verified #3797 batch (2026-07-08) — 17 companies confirmed
  // genuinely at 0 open Swiss postings, not a crawler defect. Each entry's
  // evidence lives in the #3797 issue comment; one-line summary here.
  // Workable API confirms `total:0`; page states "no job openings".
  'answerconsulting',
  // e-lavoro.ch/node/91 explicit empty state, no listed vacancies.
  'cerbios-pharma',
  // No jobs/careers page exists anywhere on chiccodoro.com.
  'chicco-doro',
  // jobs.ch profile shows "Jobs (0)"; no jobs/career page on citypop.com.
  'city-pop',
  // Official page states "Al momento non sono disponibili offerte di lavoro".
  'csc-costruzioni',
  // TUTTOJOB.ch "0 annunci"; official ATS also empty; last known ref inactive.
  'faulhaber',
  // Workday API: 101 total postings, Switzerland absent from every facet.
  'ferring',
  // e-lavoro.ch/node/76 zero listings; jobopportunity.ch subdomain is dead
  // (same defunct AITI e-recruiting platform migration as imerys).
  'helsinn',
  // Phenom People JSON embeds `"totalHits":0,"jobs":[]` for location=Coldrerio.
  'hugo-boss',
  // Official careers 403-blocked but corroborated zero via TuttoJob.ch,
  // LinkedIn, and RSI news reporting active layoffs at the Bodio site.
  'imerys',
  // 38 real postings exist but Switzerland isn't even a location-filter option.
  'interroll',
  // Greenhouse API: 21 active postings, all San Francisco/Remote-US, none CH.
  'vir-biotechnology',
  // e-lavoro.ch/node/104: "Purtroppo non ci sono offerte di lavoro".
  'has-healthcare',
  // BENTELER (Jobs2Web tenant career.benteler.jobs): 143 postings live but
  // zero attributed to a Switzerland jobLocation (all DE/US/MX/PT/ES/BR/CZ/CN/
  // AT/SA — verified 2026-07-11 enumerating every jobLocation). The group has
  // active CH entities (Zefix: Zug/Baar) but currently no CH openings; parser
  // healthy (issue #3893), re-arms when a Swiss role is posted.
  'benteler',
  // Franklin University Switzerland (Sorengo/Lugano, TI): the fus.edu
  // job-opportunities page (Drupal accordions) currently lists ACADEMIC
  // POSITIONS = "no open positions" and one ADMINISTRATIVE role whose Location
  // is a US home-office/remote post (Chicago), correctly filtered out-of-scope
  // by the parser's SWISS_LOCATION_RE. Verified live 2026-07-11: HTTP 200,
  // parser healthy, zero CH openings is the genuine state (audit #3797).
  'franklin-university',
  // INTEGRA Biosciences (Zizers, GR — but hires group-wide): the careers page
  // is behind Cloudflare bot protection (403 "Just a moment…" to datacenter
  // IPs); the crawler routes through the shared Jina clean-IP proxy and parses
  // the real listing. Verified live 2026-07-14: Jina fetch succeeds, parser
  // healthy, currently zero CH openings (the group posts mostly US/DE roles) —
  // genuine 0, not a fetch failure (issue #4144, fixed in #4114). Re-arms when
  // a CH vacancy appears.
  'integra-biosciences',
  // Privatklinik Siloah (Swiss Medical Network): the SmartRecruiters tenant
  // API (companies/SwissMedicalNetwork1/postings) currently lists 80 CH
  // postings with ZERO attributed to the Siloah department — verified
  // 2026-07-10 while migrating the SMN clinic factory to the API (issues
  // 3857/3859). Parser healthy; re-arms when Siloah publishes openings.
  // The factory's drift-vs-empty telemetry distinguishes a department-label
  // rename from this legitimate-zero state in the run logs.
  'klinik-siloah',
  // Bally (Swiss luxury leather-goods house, HQ Caslano TI): the crawler was
  // fixed (#3797) to pull from the real source — the SmartRecruiters tenant
  // "Bally" (https://jobs.smartrecruiters.com/Bally), replacing the 4 dead
  // bally.com/en-ch/careers.html-style URLs the old scraper 404'd against.
  // Verified live 2026-07-08: the public API
  // (https://api.smartrecruiters.com/v1/companies/Bally/postings) returns
  // "totalFound":0 worldwide, not just for Switzerland — Bally genuinely has
  // no open postings on this ATS right now. Parser is healthy and will pick
  // up real jobs (CH-filtered) the moment any are published.
  'bally',
  // KONE (elevators/escalators, Swiss entity KONE (Schweiz) AG, Zürich):
  // the crawler pulls from the real, live SmartRecruiters tenant "KONE1"
  // (https://api.smartrecruiters.com/v1/companies/KONE1/postings). Verified
  // live 2026-07-08: `totalFound:0` for `country=CH`, and only 1 posting
  // worldwide (Technicien de Maintenance, Charleroi, Belgium) — KONE
  // genuinely has no open Swiss postings on this ATS right now. Parser is
  // healthy and will pick up real jobs the moment any CH ones are published.
  'kone',
  // Clariant AG (SuccessFactors Jobs2Web, careers.clariant.com): verified
  // live 2026-07-12 — the `/search/?locationsearch=switzerland` filtered
  // listing returns "no open positions matching switzerland", and the
  // markup/selectors this parser targets (`data-row`, `jobTitle-link`,
  // `colLocation`, `colDepartment`) are unchanged and still correctly parse
  // the 20 rows on the unfiltered `/search/` page. Walked all 110 currently
  // open postings across all 6 result pages: none is Switzerland-located
  // (Airoli IN, Burgkirchen/Gersthofen/Moosburg/Heufeld DE, Shanghai CN,
  // Louisville/Quincy/Albuquerque US, etc.) — Clariant genuinely has 0 open
  // Swiss roles right now, not a selector break. Parser is healthy and
  // re-arms when a CH listing (historically filed under "Pratteln, CH")
  // reappears. Same legitimately-empty regional-filter case as
  // manor/bracco/fnz.
  'clariant',
  // TPL - Trasporti Pubblici Luganesi (Lugano public transport, tplsa.ch):
  // verified live 2026-07-14 — the careers page
  // (https://www.tplsa.ch/2/50/tpl-lavora-con-noi.html) returns HTTP 200 and the
  // listing parser (parseTplListingPage) is healthy: it correctly discovers the
  // current single vacancy ("Specialista Risorse Umane", idhr=748) and excludes
  // the spontaneous-application form (idhr=0). The root break was that the
  // dedicated crawler (refactored to the shared runDedicatedBaseCrawler engine)
  // was never registered in the company census, so every run exited with
  // "Missing company keys: tpl-lugano" and 0 jobs (born-broken, never produced a
  // job) — now fixed by adding the company to data/ticino-companies-extra.json,
  // so the engine resolves the key and crawls the careers page. TPL exposes its
  // openings only as thin application-form pages (/2/50/candidati/?idhr=NNN) whose
  // real job specification is a linked "Capitolato" PDF, which the generic engine
  // correctly classifies as a non-job-detail page (html_not_target_relevant) → 0
  // machine-extractable postings. A very small municipal transport operator
  // legitimately has 0 (or PDF-only, non-extractable) openings for long stretches;
  // the parser is healthy and re-arms if an extractable posting appears. Same
  // legitimately-empty small-employer case as moncucco/linnea/ail-lugano.
  'tpl-lugano',
  // Josef Müller Gemüse AG (Hünenberg ZG, produce/salad processing):
  // verified live 2026-07-21 — the jobs.ch company-profile page
  // (https://www.jobs.ch/de/firmen/33612-josef-mueller-gemuese-ag/) returns
  // HTTP 200, the "Jobs (0)" tab counter and the
  // `data-cy="company-no-vacancies"` block ("Derzeit sind keine
  // Stellenangebote vorhanden") both confirm zero current postings, and no
  // `/de/stellenangebote/detail/{uuid}/` links are present in the markup —
  // parseJosefMuellerListing() correctly extracts 0 from a genuinely
  // vacancy-free page. This is a small single-site produce processor
  // (~170 employees) that previously had exactly one listing
  // (lastNonZeroJobs: 1); it legitimately has stretches with no openings.
  // The listing selector (URL-shape regex, not a class name) and the
  // JobPosting JSON-LD detail parser are unchanged and healthy; re-arms
  // automatically when jobs.ch lists a new vacancy. Same legitimately-empty
  // small-employer case as linnea/banca-raiffeisen-vedeggio-cassarate/wuerth-international.
  'josef-mueller',
  // Yapeal AG (Swiss mobile banking, Zürich): verified live 2026-07-25 — the
  // Personio XML feed (https://yapeal-ag.jobs.personio.de/xml) returns HTTP
  // 200 with a well-formed but empty `<workzag-jobs>` document (0
  // `<position>` elements), and the careers page
  // (https://yapeal.ch/en/company/about-yapeal/careers/) still links to the
  // same `yapeal-ag.jobs.personio.de` tenant — confirming the ATS and
  // subdomain are unchanged, not a fetch/parser break. The parser's own doc
  // comment already noted this employer runs "currently a single position —
  // low volume" (issue #3337 backlog); `lastNonZeroJobs: 1` in
  // `data/crawler-health.json` matches. A neobank of this size legitimately
  // has stretches with zero open roles; the parser is healthy and re-arms
  // automatically when Yapeal republishes a posting. Same
  // legitimately-empty small-employer case as linnea/josef-mueller (#4751).
  'yapeal',
  // Temenos (Geneva-HQ banking software, Workday tenant temenos.wd103,
  // site Temenoscareers): verified live 2026-08-05 — the tenant's location
  // facet is `locationMainGroup`, so the canonical `locationCountry` facet
  // that createWorkdaySwissParser sends is rejected with HTTP 400; the
  // factory's documented fallback (refetch unfiltered + strict CH gate) then
  // fetches the WHOLE board and gets `total: 16` postings, every one of them
  // explicitly foreign (Paris, Sydney, Singapore, United States Remote,
  // London, Bertrange LU, Bucharest, Chennai, Makati City). Zero Swiss roles
  // — the Geneva HQ simply has no open req right now. The public careers
  // site (careers.temenos.com → temenos.com/about-us/careers/) links to the
  // same `Temenoscareers` Workday site, so there is no second board we are
  // missing. Listing fetch + strict CH gate are healthy and re-arm the moment
  // a Geneva/Swiss req is published. Same legitimately-empty
  // regional-filter case as bracco/fnz (#4844).
  'temenos',
  // Veeam Software (Baar ZG Swiss entity, Greenhouse board `veeamsoftware`):
  // verified live 2026-08-05 — https://boards-api.greenhouse.io/v1/boards/
  // veeamsoftware/jobs returns HTTP 200 with 235 postings worldwide (board
  // token still valid, response shape unchanged), and applying the parser's
  // own SWISS_LOCATION_RE (/switzerland|schweiz|suisse|svizzera|\bbaar\b|
  // \bzug\b/i) to every `location.name` yields 0 matches — the board is
  // currently Remote-US/Bucharest/Warsaw/Prague-heavy with no CH row at all.
  // Independently corroborated by Veeam's own front-end:
  // https://careers.veeam.com/search-jobs/Switzerland renders
  // "We found 0 jobs for Switzerland". A global vendor with a small Swiss
  // legal seat legitimately has stretches with no CH req; the Greenhouse
  // fetch + Swiss filter are healthy and re-arm when a CH posting appears.
  // Same legitimately-empty regional-filter case as bracco/fnz (#5060).
  'veeam',
  // Gavi, the Vaccine Alliance (Geneva, Salesforce fRecruit portal
  // fs-2662.my.salesforce-sites.com): verified live 2026-08-05 — the listing
  // page the parser fetches
  // (https://fs-2662.my.salesforce-sites.com/recruit/fRecruit__ApplyJobList?portal=Global)
  // returns HTTP 200 with its structure fully intact (same Visualforce
  // `pbBody` page block, same "For the vacancies listed below…" copy, same
  // Current Vacancies nav) but the results table is genuinely empty: the
  // pager reads "Page 1 of 0" and the table body renders the portal's own
  // "None found" empty state, with zero `vacancyNo=` links in the markup.
  // Nothing for a selector to fail on — the international-health alliance
  // simply has no open vacancy right now (it had 2 when the parser was
  // written). Parser + Swiss canton gate are healthy and re-arm when a
  // vacancy is republished. Same legitimately-empty small-employer case as
  // linnea/josef-mueller (#5059).
  'gavi',
  'rado',
  'swatch-group-assembly',
  // ^ rado + swatch-group-assembly (#5083, #5013): both are Swatch Group
  // sub-brands that share the group-wide swatchgroup.com/careers pool with no
  // per-brand path segment, so the shared engine stamps their `companyKey` on
  // EVERY job of the pool and `filterSharedPoolJobsByBrand()`
  // (scripts/lib/swatchgroup-brand-filter.mjs, #4392) re-derives the real
  // per-brand subset from each posting's own `company` text. Verified in the
  // production crawl log of run 30955397678 (2026-08-04T22:21:48Z): the
  // shared pool crawl is healthy — the sibling `eta-sa-swatch-group` slice
  // was written with 22 jobs in the same run — and the filter reported
  // "rado: brand filter kept 0/7 job(s)" and "swatch-group-assembly: brand
  // filter kept 0/24 job(s)". The pool's real employers that run are The
  // Swatch Group Ltd, EM Microelectronic-Marin Ltd, Tissot Ltd, MECO SA and
  // Renata AG — no Rado Watch Co. Ltd / Rado Uhren AG and no Swatch Group
  // Assembly SA posting exists to keep. Filtering to 0 is the CORRECT output
  // of a working filter, not a selector break: the brand patterns still key
  // off each brand's real legal-entity name, so a genuine future Rado or
  // Assembly posting is picked up immediately. Same class as the
  // brand/regional-filter entries above.
  //
  // CORRECTION (2026-08-10, #5392): "the shared engine stamps their
  // `companyKey` on EVERY job of the pool" above is not what happens. The
  // shared crawler de-duplicates the pool by URL across the per-companyKey
  // iterations, so each pooled posting is stamped ONCE, with whichever key
  // reached it first, and never re-stamped for the others — measured on run
  // 2026-08-09T21:52Z, where all 53 pooled jobs carried only
  // `swatch-group-assembly` and `rado`. update-swatchgroup-jobs.mjs used to
  // narrow by that key BEFORE running the brand filter, which is why "rado:
  // brand filter kept 0/7" was reported while three genuine Rado postings
  // (32617/32619/32620, hiringOrganization "Rado Watch Co. Ltd.") were live
  // in the pool under a sibling's key. Fixed via selectSharedPoolBrandJobs()
  // in scripts/lib/swatchgroup-brand-filter.mjs; rado and
  // swatch-group-assembly stay registered here because a genuinely empty run
  // remains their normal state.
  'comadur-swatch-group',
  'nivarox-swatch-group',
  // ^ comadur + nivarox (#5392, #5394): the two remaining members of the
  // same four-brand shared-pool set as rado/swatch-group-assembly above,
  // registered here for the same reason. Measured 2026-08-10 by walking the
  // whole group-wide pager (swatchgroup.com/en/job-finder?jf_country=40,
  // pages 0..11, 106 unique Swiss postings, brand read off each card's
  // /sites/default/files/brands-logos/<brand>.png marker — the same
  // discriminator scripts/lib/omega-job-parser.mjs relies on):
  //   comadur → exactly 1 live posting (job 32757 "Comptable Polyvalent",
  //     hiringOrganization "Comadur SA", Col-des-Roches 33, 2400 Le Locle)
  //   nivarox → 0 live postings; "Nivarox-FAR SA" appears nowhere in the
  //     pool, and no card carries a nivarox logo.
  // Comadur's single posting is now correctly attributed by the
  // selectSharedPoolBrandJobs() fix, so this key reports 1 today — but both
  // are small production subsidiaries that post a handful of roles a year
  // (swatchgroup-brand-filter.mjs records that neither slice has ever
  // persisted a job), so dropping back to 0 is their normal state and must
  // not reopen a "3 consecutive runs returned 0 jobs" issue. The brand
  // patterns key off the real legal-entity names (Comadur SA, Nivarox-FAR
  // SA), so a genuine posting is picked up on the next run.
  'swiss-timing-swatch-group',
  // ^ swiss-timing (#5395): unlike the four above this brand seeds from its
  // OWN domain, and all six seed URLs in its adapter had rotted to HTTP 404
  // (/careers, /career, /jobs, /karriere, /offene-stellen, /lavora-con-noi —
  // each verified individually, 2366-byte error page). The adapter now
  // points at the live page, https://www.swisstiming.com/company/job-offers/
  // (HTTP 200, the only careers link in the homepage nav). That page groups
  // openings per legal entity and the Swiss one — "Swiss Timing LTD",
  // Corgémont — renders an EMPTY <ul>; the only two live listings belong to
  // the German subsidiary ST Sportservice GmbH in Leipzig (?job=269611
  // Elektroniker, ?job=269751 System Engineer), correctly out of scope for a
  // Swiss job board. Cross-checked against the group pager above: 0 of the
  // 106 live Swiss Swatch postings carry a swiss-timing brand logo. Zero is
  // the correct output; re-arms when Corgémont publishes a vacancy.
  // Croix-Rouge fribourgeoise (cantonal Red Cross section, JobCloud Company
  // Page https://company.jobcloud.ch/fr/job-list/1773421929172x328595190866247700):
  // verified live 2026-08-03 — the server-rendered listing page returns HTTP
  // 200 with its structure unchanged (same Webflow CMS collection, same
  // `job-list` id) but the collection is now genuinely empty: the page's own
  // empty-state copy reads "Il n'y a actuellement aucun poste vacant" (no
  // markup extraction to fail — 0 job-detail `href`s present at all). The
  // parser's docblock previously noted 3 open postings; a cantonal Red Cross
  // section of this size legitimately has stretches with zero openings. The
  // listing/detail selectors are unchanged and healthy; re-arms automatically
  // when the org republishes a vacancy. Same legitimately-empty small-employer
  // case as linnea/josef-mueller/yapeal.
  'croix-rouge-fribourgeoise',
  // Clinica Varini (Orselina, TI): the /notizie/ WordPress page (verified
  // live 2026-08-08) returns HTTP 200 with its structure unchanged — same
  // `wp-content/uploads/*.pdf` anchors — but currently only lists
  // `comunicato_stampa`/`vernissage`/`attestato` press-release PDFs, zero
  // filenames matching the `concorso|bando|posto|annuncio` job pattern. The
  // parser's docblock previously noted 2 concorsi (contabile,
  // dir_sanitario) at probe time; both have since been filled or expired
  // and no new one was republished. Listing extraction is healthy (still
  // finds and correctly filters all 6 current PDF links); this is a small
  // private clinic that legitimately has stretches with zero open
  // competitions. Re-arms automatically when a new concorso PDF is
  // published. Same legitimately-empty small-employer case as
  // linnea/moncucco/banca-raiffeisen-vedeggio-cassarate.
  'clinica-varini',
  // Saint-Gobain Weber/Isover Suisse (jobs.ch company pages 40563-saint-gobain-weber-ag
  // and 107006-saint-gobain-isover-sa, #5669): verified live 2026-08-12 — both
  // pages return HTTP 200 with the listing markup unchanged (same
  // `data-cy="company-vacancies"` section, same `/en/vacancies/detail/{uuid}/`
  // anchor format the parser targets — cross-checked against a company page
  // WITH live postings, e.g. 20439-equans-switzerland-ag, where the same regex
  // still extracts links correctly) but each `data-cy="company-no-vacancies"`
  // block now explicitly reads "Currently, no job offers" / "Currently, there
  // are no job offers". Both Swiss legal entities of this building-materials
  // group legitimately have zero open postings right now (`lastNonZeroJobs: 1`
  // in crawler-health.json — always a low-volume employer). The listing
  // selector is healthy; re-arms automatically when either entity republishes
  // a vacancy. Same legitimately-empty small-employer case as
  // linnea/wuerth-international/clinica-varini.
  'saint-gobain-weber-isover',
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

/** List `*.json` slugs in a dir (best-effort; empty array on read failure). */
async function listJsonSlugs(dir) {
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/, ''));
  } catch (err) {
    console.error(`[health] Cannot read ${dir}: ${err.message}`);
    return [];
  }
}

/**
 * List all known crawler slugs: union of `data/jobs/by-crawler/*.json` and
 * `data/jobs-crawler-summaries/by-crawler/*.json`. A crawler that has never
 * produced an active-jobs shard (e.g. `earlyExit: true` on every run) only
 * ever writes the summary slice — reading BY_CRAWLER_DIR alone made those
 * crawlers permanently invisible to this monitor (issue #3797).
 */
async function listCrawlerSlugs() {
  const [byCrawler, summaries] = await Promise.all([
    listJsonSlugs(BY_CRAWLER_DIR),
    listJsonSlugs(SUMMARIES_DIR),
  ]);
  return [...new Set([...byCrawler, ...summaries])].sort();
}

/**
 * Inspect one crawler and return derived facts.
 *
 * Reads:
 *   - `data/jobs/by-crawler/{slug}.json`            → activeJobCount + fallback timestamp
 *   - `data/jobs-crawler-summaries/by-crawler/{slug}.json` → primary timestamp
 *
 * The by-crawler slice is optional — a crawler that has never produced an
 * active-jobs shard (e.g. every run exits early with `earlyExit: true`,
 * issue #3797) is tracked via the summary slice alone instead of being
 * skipped. `activeJobCount` and `assembledAt` degrade to 0/null in that case.
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
    console.warn(`[health] ${slug}: no active-jobs shard (never produced or unparseable) — tracking via summary only`);
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
export { nextCrawlerState, inspectCrawler, listCrawlerSlugs };

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