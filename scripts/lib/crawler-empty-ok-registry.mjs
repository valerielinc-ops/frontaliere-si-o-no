/**
 * Registry degli zeri ammessi del monitor crawler-health.
 *
 * `EMPTY_OK_CRAWLERS` elenca gli slug il cui run PUBBLICATO a 0 job vale come
 * sano. Non maschera un abort dell'exit guard: `nextCrawlerState` richiede
 * anche `!abortedRun`, `!fetchFailed` e `!pipelineDroppedAll`. Vive qui, fuori
 * da `scripts/check-crawler-health.mjs`, perché ogni PR per azienda che toglieva
 * il proprio slug toccava il file della logica del monitor e andava in
 * conflitto con le altre (PR 11135, 11136, 11147 chiuse e rifatte).
 *
 * LA REGISTRY È CHIUSA. Un nuovo zero legittimo si dichiara con una prova nel
 * parser (`markAuthoritativeEmptySnapshot` / `authoritativeEmptySnapshotValidator`,
 * oppure i conteggi `discovered` e `lastFetchOutcome` del template), mai con
 * una voce nuova: una voce maschera lo slug anche dopo che la sorgente muore
 * (issue 6496). Una PR per azienda NON deve toccare questo file: una voce
 * ridondante accanto a una prova per-run è inerte per costruzione. Le voci si
 * tolgono, non si aggiungono: `tests/crawler-empty-ok-registry.test.ts` tiene
 * un ratchet sulla dimensione e impedisce che la lista torni nel monitor.
 */

// These custom runners used the pre-template field name before adopting the
// canonical summary contract. Keep already-published summaries readable while
// requiring every new runner to emit `authoritativeEmptySnapshot`.
export const LEGACY_SOURCE_PROVEN_EMPTY_CRAWLERS = new Set(['linnea', 'tpl-lugano']);
export const EMPTY_OK_CRAWLERS = new Set([
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
  // Schweizer Paraplegiker-Gruppe (Umantis tenant 2782): the listing endpoint
  // (/Jobs/All) still returns ~10 jobs, but the per-job detail URLs
  // (/Vacancies/{id}/Description/*) now 3xx-redirect cross-host — the tenant
  // migrated its job descriptions off Umantis (issue #1245). The shared
  // umantis parser correctly QUARANTINES every dead-detail job (it refuses to
  // synthesise boilerplate that would trip the dataset boilerplate-guard) and
  // emits 0 — the accepted degraded state for a migrated source, NOT a parser
  // break. Re-arms automatically if the tenant restores Umantis detail pages.
  // Real fix (per-tenant public-site description extraction) is deferred in
  // #1245 as fragile/per-tenant. (`upd`, the other tenant of this class, now
  // reads the Prospective medium its redirect leads to and is no longer
  // expected to be empty — issue 5253.)
  'paraplegie',
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
  // Browser-verified #3797 batch (2026-07-08) — 17 companies confirmed
  // genuinely at 0 open Swiss postings, not a crawler defect. Each entry's
  // evidence lives in the #3797 issue comment; one-line summary here.
  // Workable API confirms `total:0`; page states "no job openings".
  'answerconsulting',
  // No jobs/careers page exists anywhere on chiccodoro.com.
  'chicco-doro',
  // `city-pop` left this list on 2026-10-05 (issue 11653): it now proves its
  // zero every run from the jobs.ch search API's own `totalHits: 0`
  // (`jobsChAuthoritativeEmptyOrNull`, scripts/lib/jobs-ch-search-common.mjs).
  // Official page states "Al momento non sono disponibili offerte di lavoro".
  'csc-costruzioni',
  // TUTTOJOB.ch "0 annunci"; official ATS also empty; last known ref inactive.
  'faulhaber',
  // `ferring` left this list on 2026-10-02: it now proves its Swiss zero every
  // run from the live Workday board (`proveSwissAbsentFromLiveBoard` on the
  // tenant's `Location_Country` facet, scripts/update-ferring-jobs.mjs).
  // `imerys` left this list on 2026-10-02: the "corroborated zero" was a dead
  // source (the SmartRecruiters company no longer exists) while its Workday
  // board listed 3 Swiss reqs. It now proves its own zero every run
  // (`proveSwissAbsentFromLiveBoard`, scripts/update-imerys-jobs.mjs).
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
  // Privatklinik Siloah (Swiss Medical Network): the SmartRecruiters tenant
  // API (companies/SwissMedicalNetwork1/postings) currently lists 80 CH
  // postings with ZERO attributed to the Siloah department — verified
  // 2026-07-10 while migrating the SMN clinic factory to the API (issues
  // 3857/3859). Parser healthy; re-arms when Siloah publishes openings.
  // The factory's drift-vs-empty telemetry distinguishes a department-label
  // rename from this legitimate-zero state in the run logs.
  'klinik-siloah',
  // Clinique de Montchoisi (Swiss Medical Network, Lausanne VD): same SMN
  // clinic factory, same legitimate zero. Verified live 2026-09-06 against the
  // tenant API — 99 active CH postings, none under the "Clinique de Montchoisi"
  // department, and no `CDM` value in the Brands custom field; the public
  // swissmedical.net/fr/carriere/offres-emploi?clinic=CDM page renders "Aucun
  // résultat trouvé". The department itself is NOT gone: the tenant department
  // directory (/v1/companies/SwissMedicalNetwork1/departments) still lists
  // "Clinique de Montchoisi" (id 5485890, archived:false), so this is an empty
  // board, not a rename — the clinic's last own-department posting
  // (744000134770892, Technicien(ne) en radiologie médicale) simply closed
  // after 2026-08-28. Parser healthy; re-arms when Montchoisi publishes again
  // (issue #7320).
  'clinique-de-montchoisi',
  // `kone` left this list on 2026-10-02: the SmartRecruiters tenant `KONE1`
  // it read (1 posting, Belgium) was never KONE's board; its Workday site
  // lists the Swiss reqs (6 live). It now proves its own zero every run
  // (`proveSwissAbsentFromLiveBoard`, scripts/update-kone-jobs.mjs).
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
  // Baronie / Chocolat Alprose SA (#5851): the parser was already repaired by
  // PR #5860 (merged 2026-08-14) — this is NOT a second parser break. Verified
  // live 2026-08-15: https://www.baronie.com/en/careers returns HTTP 200 and
  // the discovery regex still extracts all 4 `/en/jobs/{slug}` anchors, each
  // detail page parses end-to-end (JSON-LD JobPosting present; titles, 3-4
  // content sections and 1.9-2.9 KB of markdown each). All 4 openings are
  // outside Switzerland — Bruges (BE), Norderstedt (DE) ×2, Merthyr Tydfil
  // (UK) — so `isSwissJob` legitimately keeps 0/4 and the run writes 0 jobs.
  // `lastNonZeroJobs: 1` is physiological for a chocolate manufacturer whose
  // Swiss site (Caslano, TI) posts roughly one role at a time; the crawler is
  // healthy and re-arms as soon as an Alprose/CH listing reappears. Same
  // legitimately-empty regional-filter case as manor and alten-switzerland.
  'baronie',
  // Bitfinex (Lugano TI, cryptocurrency exchange): verified live 2026-08-17
  // (issue #5968) — the careers site migrated ATS domains from
  // bitfinex.recruitee.com to the custom domain careers.bitfinex.com
  // (bitfinex.recruitee.com now 302-redirects there), but it is still the
  // same Recruitee backend (window.recruitee.customIntegrationsApi.companyId
  // 26705) and the parser's `API_URL`
  // (https://bitfinex.recruitee.com/api/offers) still resolves and returns
  // HTTP 200 with the unchanged `{"offers":[...]}` shape — confirmed by
  // querying the new custom-domain endpoint
  // (https://careers.bitfinex.com/api/offers), which returns the identical
  // `{"offers":[]}`. The rendered careers page states in plain text
  // "Currently we don't have any open positions." Bitfinex genuinely has
  // zero open roles right now; the parser and API are healthy and re-arm
  // automatically when a position is republished. Same legitimately-empty
  // small-employer case as linnea/dxt-commodities/gavi.
  'bitfinex',
  // DIC SA ingénieurs (Aigle VD, jobs.ch/jobup.ch company UUID
  // ee30c164-1431-42ab-af87-d45a5dc3579f, #5969): verified live 2026-08-17 —
  // the jobs.ch public search API
  // (https://job-search-api.jobs.ch/search?companyIds=ee30c164-1431-42ab-af87-d45a5dc3579f)
  // returns HTTP 200 with the unchanged `{documents:[],numPages:0,totalHits:0}`
  // shape (same endpoint/shape still used successfully by sibling jobs.ch
  // parsers, e.g. equans/city-pop), and the company profile page
  // (https://www.jobup.ch/fr/societes/ee30c164-1431-42ab-af87-d45a5dc3579f-dic-sa/)
  // explicitly reports `jobCount":0`/`totalHits":0`. This is not the 2026-07-08
  // detail-locale 404 bug (already fixed by PR #3838 — the parser has used the
  // 'en' detail-locale prefix since then); the API/parser are healthy and
  // simply have nothing to return. `lastNonZeroJobs: 1` is physiological for
  // this small civil-engineering consultancy, which historically has a single
  // opening at a time. Same legitimately-empty small-employer case as
  // linnea/wuerth-international/clinica-varini/saint-gobain-weber-isover;
  // re-arms automatically when DIC SA republishes a vacancy.
  'dic-sa',
  // Elettra 1938 (Stabio TI, recruits through the shared Gruppo Horien /
  // FIAMM Components InRecruiting portal, #5970): verified live
  // 2026-08-17 — https://inrecruiting.intervieweb.it/fiammcomponents/it/career
  // returns HTTP 200 with the listing markup unchanged (the `.vacancy__render`
  // card selector the parser targets is still referenced in the page's own
  // CSS, `#vacancyList`/`vacancyListCareer` AJAX plumbing intact) and the
  // page's own `act1=vacancyListCareer` AJAX endpoint (used directly, no
  // filters, same one the initial page load calls) returns
  // `{"success":true,"data":"...Nessun annuncio disponibile..."}` — a
  // genuinely empty listing, group-wide, not just for the Stabio/Svizzera
  // location filter the parser applies afterward. `lastNonZeroJobs: 1` is
  // physiological for this small electrical-systems brand, which historically
  // has a single opening at a time on the shared portal. The parser is
  // healthy; re-arms automatically when the group republishes a Stabio
  // vacancy. Same legitimately-empty small-employer case as
  // dic-sa/saint-gobain-weber-isover/clinica-varini.
  'elettra-1938',
  // Cham Swiss Properties AG (Cham ZG, jobs.ch company id 142189, #5997):
  // verified live 2026-08-18 — the jobs.ch public search API
  // (https://job-search-api.jobs.ch/search?companyIds=142189) returns HTTP 200
  // with the unchanged `{documents:[],numPages:0,totalHits:0}` shape (same
  // endpoint/shape still used successfully by sibling jobs.ch parsers, e.g.
  // dic-sa/city-pop), and the company profile page
  // (https://www.jobs.ch/en/companies/142189-cham-swiss-properties-ag/) is
  // still the sole, active record — no `redirectToCompanyId`/
  // `redirectToCompanySlug`, confirming id 142189 hasn't migrated the way DIC
  // SA's did. This is not a selector break; the API/parser are healthy and
  // simply have nothing to return right now. `lastNonZeroJobs: 1` is
  // physiological for this small real-estate developer, which historically
  // has a single opening at a time (the parser's own docblock already notes
  // this). Same legitimately-empty small-employer case as
  // dic-sa/elettra-1938/saint-gobain-weber-isover; re-arms automatically when
  // Cham Swiss Properties republishes a vacancy.
  'cham-swiss-properties',
  // Clinique romande de réadaptation (CRR Suva, Sion VS, #6156): verified
  // live 2026-08-20 — https://www.crr-suva.ch/clinique-readaptation/carriere-797.html
  // returns HTTP 200 with the `class="listElement"` markup the parser
  // targets unchanged (9 `listElement` anchors still present site-wide).
  // The dedicated "Postes vacants" list (`#offreemploilikenewsListCtn`)
  // currently contains a single entry, "Candidature spontanée"
  // (`candidature-spontanee-802.html`) — the generic spontaneous-application
  // card the parser already excludes via `EXCLUDED_SLUG_PATTERNS`, with no
  // DD.MM.YYYY "online since" date. No real dated posting is present, so
  // `parseListing()` correctly returns 0 rows; this is not a selector
  // break. `lastNonZeroJobs: 2` is physiological for this small rehab
  // clinic's HR team. Parser is healthy; re-arms automatically when CRR
  // Suva republishes an opening.
  'crr-suva-sion',
  // FART — Ferrovie Autolinee Regionali Ticinesi (Locarno, #6157): verified
  // live 2026-08-20 — https://fartiamo.ch/lavora-con-noi-concorsi/ was
  // restructured (`page-sitemap.xml` `lastmod: 2026-08-17`) from the
  // `<h5>` title + PDF "CONCORSO" link listing the parser targets to a
  // generic "Candidatura per un concorso pubblicato" spontaneous-application
  // form. The page has zero `<h5>` elements now (confirmed via curl), and
  // the form's own "Selezioni il concorso per il quale desidera candidarsi"
  // dropdown — populated by FART itself with currently-open concorsi —
  // contains only the placeholder option, i.e. FART confirms zero open
  // concorsi right now, not a scraping failure. `lastNonZeroJobs: 2` is
  // physiological for this small regional operator. Parser is healthy;
  // re-arms automatically when FART republishes a concorso in the new
  // listing format (structure unknown until one appears — no live sample
  // to build a selector against yet).
  'fart',
  // Ardian (private equity, Zurich office, #6344): verified live 2026-08-24
  // via a direct query against the tenant's Workday careers API with the
  // Switzerland location filter applied (same UUID the dedicated parser
  // already scopes to) — response is a definitive zero-results shape, and
  // the unfiltered global query (56 open roles worldwide) lists Switzerland
  // among the location facets with no count at all, while every other open
  // country (France/Germany/UK/USA/Luxembourg/Spain/Canada/Japan/Korea)
  // shows one. This is not a selector break: the tenant/API/location scope
  // are unchanged and still correct; Ardian's Zurich office simply has zero
  // open Swiss roles right now. `lastNonZeroJobs: 1` is physiological for
  // this small local office of a global firm. Parser is healthy; re-arms
  // automatically when Ardian republishes a Swiss vacancy. Same
  // legitimately-empty small-employer case as fart/crr-suva-sion.
  'ardian',
  // VISIONAPARTMENTS / Vision Management Services GmbH (Zürich, #6345):
  // verified live 2026-08-24 — the jobs.ch company profile
  // (https://www.jobs.ch/en/companies/69c35774-5e33-4b40-94e0-4a9d949707c6-vision-management-services-gmbh/vacancies/)
  // renders jobs.ch's own explicit zero-openings marker
  // (`data-cy="company-no-vacancies"`), and the vacancy-listing markup the
  // dedicated parser targets is confirmed still correct against a sibling
  // jobs.ch company profile with live openings (e.g. jobcloud-ag) fetched
  // the same way. This is not a selector break: the company profile
  // id/markup are unchanged and still correct; VISIONAPARTMENTS simply has
  // zero open Swiss roles right now.
  // `lastNonZeroJobs: 1` is physiological for this single-listing local
  // employer. Parser is healthy; re-arms automatically when
  // VISIONAPARTMENTS republishes a Swiss vacancy. Same legitimately-empty
  // small-employer case as ardian/fart/crr-suva-sion.
  'visionapartments',
]);
