# Canonical Cards Adoption + SEO Landing Refresh — Design

**Date:** 2026-05-19
**Author:** valerielinc
**Status:** Design (pending implementation plan)
**Trigger:** `/lavoro-ticino-educatore/` job cards lack company logos and don't match the canonical SPA `<JobCard>` look. Same gap on sibling landings (career, nursing, cost-of-living) and on the "aziende che assumono in Ticino" pages.

## Problem

Job-board cards rendered on SEO landing pages diverge from the canonical template in two ways:

1. **Job cards** — 4 build plugins (`professionLandingsPlugin`, `careerLandingsPlugin`, `nursingLandingsPlugin`, `costOfLivingLandingsPlugin`) each define their own `renderFeaturedJobCard()` with inline styles. Missing vs canonical: company logo (with full fallback chain), "Nuovo" freshness badge, formatted salary/contract/posted chips, hover lift, responsive sizing. The canonical renderer (`build-plugins/shared/jobCardHtml.ts`) is already used by `jobsSeoPagesPlugin`, `jobSectorPagesPlugin`, `jobRecencyPagesPlugin`, `orphanQueryLandingPlugin`, and partly by `weeklyEmployersPlugin`.
2. **Employer cards** — no shared renderer exists. 5 plugins (the 4 above + `weeklyEmployersPlugin`) each implement their own `renderEmployerGrid()` / equivalent. Result: inconsistent logo handling, inconsistent meta layout, no single source of truth.

On top of the structural gap, the SEO landings (educatore et al.) currently feel sterile vs the rest of the site: no hero personality, monochrome stats, robotic empty states. User asked for "più carina e funny" without sacrificing the SEO-landing mobile-first template defined by CLAUDE.md non-negotiable #17.

## Goals

- **Job cards everywhere identical.** All landing pages emit `<article>` markup byte-equivalent (modulo `href` and job data) to the canonical `renderJobCardHtml`. Single point to change card design site-wide going forward.
- **Employer cards unified.** New `build-plugins/shared/employerCardHtml.ts` with `compact` + `detailed` variants, shared by all 5 plugins. Logo fallback chain reused from `jobCardHtml.ts` via a small extracted module.
- **Landings feel alive.** Hero gets an emoji+tagline personality layer; stats tiles bind to semantic OKLCH tokens (`STAT_TILE_SUCCESS/WARNING/DANGER/ACCENT/BASE`) so colors carry meaning; empty states and CTAs use curated micro-copy with light editorial voice; one small `seo-fade-in` CSS animation respects `prefers-reduced-motion`.
- **Zero regression on SEO ratchets.** Title length, footer-root presence, text-html ratio, BFS depth, image-object license, h1-title-duplicates — all gates stay green or improve.
- **No new pages, no new URLs.** Refresh-only. Exempt from CLAUDE.md non-negotiable #19 (SEO moratorium) clause (a) "bug fixes to existing landings, no new files added". Net file count for emitted HTML: zero delta.

## Non-Goals

- Changing the canonical `jobCardHtml.ts` renderer markup (would force a re-test of every plugin already on it; not needed for this work).
- Touching `jobsSeoPagesPlugin`, `jobSectorPagesPlugin`, `jobRecencyPagesPlugin`, `orphanQueryLandingPlugin` (already canonical).
- Adding new emoji-heavy generative content. Emoji palette is a curated, fixed table (≤15 entries) hand-picked per landing id.
- Adding any new SEO landings or expanding emitter scope to new keywords/cantons/categories. Moratorium-respecting.

## Architecture

### New shared modules

```
build-plugins/shared/
├── companyLogoResolver.ts        [NEW — extracted from jobCardHtml.ts]
│   exports: resolveCompanyLogoUrl, resolveCompanyWebsiteHost,
│            generateInitialsLogo, LOGO_FALLBACK_SRC
│
├── jobCardHtml.ts                [UPDATED — imports from companyLogoResolver]
│   public API unchanged
│
├── employerCardHtml.ts           [NEW]
│   exports: renderEmployerCardHtml, renderEmployerCardListHtml
│            type EmployerCardEmployer, EmployerCardOptions
│
├── landingHeroPersonality.ts     [NEW]
│   exports: HERO_BADGES (table id → emoji + i18n eyebrow + i18n tagline template)
│            renderLandingHero(id, locale, vars)
│
└── landingMicroCopy.ts           [NEW]
    exports: pickEmptyState(id, locale)
             pickCtaAllJobs(id, locale, count)
    deterministic per-(id × locale) selection via hash
```

### Public API — `employerCardHtml.ts`

```typescript
export interface EmployerCardEmployer {
  name: string;
  companyKey?: string;
  companyDomain?: string;
  url?: string;
  logo?: string | null;
  openings?: number | null;
  city?: string | null;
  sector?: string | null;
}

export interface EmployerCardOptions {
  href: string;
  locale: 'it' | 'en' | 'de' | 'fr';
  variant?: 'compact' | 'detailed';
  openingsLabel?: (n: number) => string;
}

export function renderEmployerCardHtml(
  e: EmployerCardEmployer,
  opts: EmployerCardOptions,
): string;

export function renderEmployerCardListHtml(
  items: ReadonlyArray<{ employer: EmployerCardEmployer; href: string }>,
  opts: Omit<EmployerCardOptions, 'href'> & {
    ulClassName?: string;
    emptyStateHtml?: string;
  },
): string;
```

- `compact` variant — used by `professionLandings`, `careerLandings`, `nursingLandings`, `costOfLivingLandings`. Grid `repeat(auto-fit, minmax(220px, 1fr))`, logo 36×36, name + openings count.
- `detailed` variant — used by `weeklyEmployersPlugin`. Larger card: logo 48×48, name, sector, city, openings, last-posted, link to employer detail.

Both variants use only Tailwind classes already present in the SPA bundle (relies on `tailwind.config.js` already scanning `./build-plugins/**/*.{js,ts}` per CLAUDE.md regola #14).

### Hero personality

```typescript
// landingHeroPersonality.ts
export interface ProfessionHeroBadge {
  emoji: string;
  eyebrowLabel: Record<Locale, string>;
  taglineTemplate: Record<Locale, (vars: HeroVars) => string>;
}

interface HeroVars {
  openings: number;
  medianSalary?: number;
  city?: string;
}

export const HERO_BADGES: Record<string, ProfessionHeroBadge> = {
  educatore: {
    emoji: '🎓',
    eyebrowLabel: {
      it: 'Professione · Educatore in Ticino',
      en: 'Profession · Educator in Ticino',
      de: 'Beruf · Erzieher im Tessin',
      fr: 'Métier · Éducateur au Tessin',
    },
    taglineTemplate: {
      it: (v) => `Lavoro con bambini e ragazzi: ${v.openings} posti aperti${v.medianSalary ? `, ~CHF ${Math.round(v.medianSalary/1000)}k/anno` : ''}.`,
      // ... en, de, fr
    },
  },
  // ... 11 more profession ids + career ids + nursing ids + cost-of-living city ids
};

export function renderLandingHero(
  id: string,
  locale: Locale,
  vars: HeroVars,
  title: string,
): string;
```

Hero markup (mobile-first, respects CLAUDE.md regola #17):

```html
<header>
  <p class="text-sm font-semibold text-accent flex items-center gap-1.5">
    <span aria-hidden="true">🎓</span> Professione · Educatore in Ticino
  </p>
  <h1 class="text-2xl sm:text-3xl font-display font-bold text-heading mt-2">…</h1>
  <p class="text-base text-body mt-2 max-w-prose">{tagline ≤120 char}</p>
</header>
```

Vincolo: vitest `landing-tagline-length.test.ts` valida `tagline.length <= 120` per ogni `(id × locale)` rendering con HeroVars realistici (openings=47, medianSalary=65000). Merge bloccato se fallisce.

### Stats tiles colorate

I 4 plugin landing oggi non hanno tiles strutturate (numeri inline nel prose). Aggiungo subito dopo l'header una grid 3-5 tile usando i token semantici di `seoContentTokens.ts`:

| Metrica | Token | Soglia |
|---|---|---|
| Posti aperti | `STAT_TILE_SUCCESS` se >20, `STAT_TILE_WARNING` se 5-20, `STAT_TILE_BASE` se <5 | |
| Stipendio mediano | `STAT_TILE_ACCENT` | sempre |
| Top employer count | `STAT_TILE_BASE` | sempre |
| Posti freschi (≤7gg) | `STAT_TILE_SUCCESS` se >0, `STAT_TILE_BASE` se =0 | |
| Trend WoW | `STAT_TILE_SUCCESS` ↑ / `STAT_TILE_DANGER` ↓≥20% / `STAT_TILE_WARNING` ↓<20% | |

Zero hex inline, tutte le tile bindano `var(--color-*-subtle)` + `var(--color-*-border)`. Dark mode automatico.

**Graceful degradation**: ogni metrica ha un'origine specifica nello snapshot (`totalCount`, `salaryStats.median`, `topEmployers.length`, `freshCount` calcolabile filtrando `featured` per `daysAgo ≤ 7`, `wowTrend` da `snapshot.weeklyDelta` se presente). Se un dato manca → la tile corrispondente NON viene emessa (no tile "N/A"). Numero minimo tile = 2 (openings + medianSalary tipicamente sempre presenti); numero massimo = 5. Test snapshot verifica almeno 2 tile sempre presenti per id=educatore (sentinel).

### Micro-copy

```typescript
// landingMicroCopy.ts
export const EMPTY_FEATURED_JOBS: Record<Locale, ReadonlyArray<string>> = {
  it: [
    'Per ora nessuna offerta: torna lunedì, le aziende caricano dopo il weekend.',
    'Categoria silenziosa oggi. Iscriviti alla newsletter per essere il primo a saperlo.',
    'Zero annunci freschi qui — ma il tuo CV potrebbe già fare la differenza.',
  ],
  en: [...], de: [...], fr: [...],
};

export const CTA_ALL_JOBS: Record<Locale, ReadonlyArray<(n: number) => string>> = {
  it: [
    (n) => `Vedi tutti i ${n} annunci →`,
    (n) => `Sfoglia gli ${n} posti aperti →`,
    (n) => `Tutte le ${n} offerte di {profession} →`,
  ],
  // ...
};

export function pickEmptyState(id: string, locale: Locale): string;
export function pickCtaAllJobs(id: string, locale: Locale, count: number): string;
```

Selezione deterministica per `(id × locale)` via hash (no flicker tra build). Test vitest: ogni messaggio ≤140 char.

### Animazione fade-in

In `index.css`:

```css
@keyframes seo-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: none; }
}
.seo-fade-in { animation: seo-fade-in 320ms ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .seo-fade-in { animation: none; }
}
```

Applicata alle stats tiles. Zero JS, ~15 righe CSS totali.

## Data flow

### Snapshot enrichment (Phase B)

Gli aggregati attualmente espongono `daysAgo` ma non `postedDate` ISO. Per supportare il chip "Nuovo" + `data-posted` del canonical renderer, aggiungo `postedDate: string | null` (formato ISO `YYYY-MM-DD`) ai seguenti file:

- `build-plugins/professionJobsAggregate.ts` — interface `FeaturedJob`
- `build-plugins/careerJobsAggregate.ts` — interface `FeaturedJob`
- `build-plugins/nursingJobsAggregate.ts` — interface `FeaturedJob`
- `build-plugins/cityJobsAggregate.ts` — interface `FeaturedJob`

Source: stesso campo che oggi serve a calcolare `daysAgo`. `daysAgo` resta (back-compat per altri consumer). Tipo: `string | null` (null se source data missing — il renderer gestisce ed evita di emettere il chip).

### Plugin rendering changes

```typescript
// PRIMA (professionLandingsPlugin.ts:166)
function renderFeaturedJobCard(job: FeaturedJob, locale, copy): string {
  return `<a class="seo-card-link" href="..." style="...">
    <div style="font-weight:700;...">${esc(title)}</div>
    ...
  </a>`;
}

// DOPO
import { renderJobCardListHtml, type JobCardJob } from './shared/jobCardHtml';

function renderFeaturedJobs(locale, snapshot, copy): string {
  const items = snapshot.featured.map((j) => ({
    job: j as JobCardJob,
    href: buildFeaturedJobUrl(j, locale),
  }));
  const listHtml = renderJobCardListHtml(items, {
    locale,
    emptyStateHtml: `<p class="text-sm text-subtle">${esc(pickEmptyState(id, locale))}</p>`,
  });
  const ctaHref = buildJobBoardUrl(locale);
  return `<section style="margin:0 0 28px">
    <h2 class="text-xl font-bold text-heading mb-3">${esc(copy.featuredJobsTitle)}</h2>
    ${listHtml}
    <a href="${esc(ctaHref)}" class="...">${esc(pickCtaAllJobs(id, locale, snapshot.totalCount))}</a>
  </section>`;
}
```

Stesso pattern per gli employer:

```typescript
// PRIMA — renderEmployerGrid con inline-style cells

// DOPO
import { renderEmployerCardListHtml } from './shared/employerCardHtml';

const items = employers.map((e) => ({
  employer: { name: e.name, companyKey: e.key, openings: e.count, ... },
  href: buildEmployerUrl(e, locale),
}));
return renderEmployerCardListHtml(items, { locale, variant: 'compact' });
```

## Testing

### New vitest files

1. **`tests/build-plugins/employer-card-html.test.ts`**
   - Renders compact + detailed variants with synthetic employer data.
   - Asserts: logo div present, name escaped, count present when >0, ARIA attributes, no hex inline.
   - Logo fallback chain: explicit `logo` > resolved > favicon > initials SVG > placeholder.

2. **`tests/build-plugins/job-card-canonical-adoption.test.ts`**
   - For each of the 4 migrated plugins, calls the renderFeatured function with a fixture and asserts the output contains:
     - `<div class="w-10 h-10 sm:w-14 sm:h-14 rounded-lg`
     - `class="lucide lucide-map-pin`
     - `data-posted=`
     - `<article class="rounded-xl border p-3 sm:p-4`
   - Fails if any plugin reverts to inline-style cards.

3. **`tests/build-plugins/landing-tagline-length.test.ts`**
   - For each `(id × locale)` in `HERO_BADGES`, calls the tagline template with realistic vars and asserts `result.length <= 120`.

4. **`tests/build-plugins/landing-micro-copy.test.ts`**
   - Asserts every empty-state and CTA message ≤140 char.
   - Asserts deterministic selection (same `(id, locale)` → same string).

### CI wiring

Confermare che `npm test` gira in CI (`deploy.yml` o un test workflow dedicato). Se non lo è, aggiungere uno step in `deploy.yml` PRIMA della build per evitare il pattern "gate finto" (memoria `feedback_regression_gates_need_ci_runner.md`, PR #294 / #319 caso reale). Verifica: `grep -rln "npm test\|npm run test" .github/workflows/`.

### Manual verification (post-merge, live)

- `curl https://frontaliereticino.ch/lavoro-ticino-educatore/` + grep `w-10 h-10 sm:w-14 sm:h-14 rounded-lg` (logo div), `Logo ` (alt), `🎓 Professione` (hero), `--color-success-subtle` o classe equivalente nelle tile.
- Stesso check per `/lavoro-ticino-{infermiere,impiegato,operaio}/` (3 sample profession ids).
- 1 pagina per ognuno degli altri 3 plugin (career, nursing, costOfLiving).
- 1 pagina weekly-employers per validare la variant detailed.
- Playwright snapshot a viewport 414px per visual diff (mobile-first non-negotiable #15).

## Rollout

**Single squash-merge PR**, worktree-isolated, in linea con CLAUDE.md PR-as-merge-vehicle.

### Phases (eseguite tutte nello stesso worktree, single commit)

| Phase | Scope | Files |
|---|---|---|
| A | Infra | 4 new shared/ files, 1 update to jobCardHtml.ts, 1 new test |
| B | Snapshot enrichment | 4 aggregati: +`postedDate` |
| C | Job-card migration | 4 plugin: rimuove `renderFeaturedJobCard`, importa shared, 1 new test |
| D | Employer-card migration | 5 plugin: sostituisce `renderEmployerGrid` |
| E | Stylistic refresh | 4 plugin landing: hero + tiles + micro-copy + fade-in; 1 update a `index.css`; 2 new test |
| F | Ship | prepush:fast, commit, push, PR create+squash, branch delete, ExitWorktree |

### Branch + worktree

```bash
EnterWorktree → refactor/canonical-cards-and-landing-refresh
# all changes + commit
git push -u origin refactor/canonical-cards-and-landing-refresh
gh pr create --fill
gh pr merge <n> --squash
git push origin --delete refactor/canonical-cards-and-landing-refresh
ExitWorktree(action: remove, discard_changes: true)
```

### Post-merge

1. `gh run watch <deploy-id>` — attendi conclusion success.
2. Live curl + grep su 6+ pagine (vedi sopra).
3. `npx gitnexus analyze` per ri-indicizzare (hook PostToolUse dovrebbe gestire — verifica).

## Risks

| Risk | Probability | Mitigation |
|---|---|---|
| Tailwind purge classi nuove nei plugin shared | Low | `tailwind.config.js` già scansiona `./build-plugins/**/*.{js,ts}` (CLAUDE.md regola #14, confermata 2026-05-07). Test snapshot grep classi critiche. |
| `postedDate` missing in source data | Medium | Phase B aggiunge campo opzionale; fallback null → chip "Nuovo" non renderizzato (no errore). |
| Tagline >120 char in DE (locale verbose) | Medium | Test gate vitest blocca merge; template DE può omettere "im Tessin" se serve. |
| Emoji rendering inconsistente su vecchi Android/Windows | Low | Palette curata di 10-15 emoji con copertura universale (🎓🚑🍳⚙️👶📊🏗️💼🩺🏠). Apple Color Emoji + Twemoji fallback nativo. |
| SEO moratorium (#19) | Zero | Refresh-only, no new files emitted, no scope expansion. Esente clausola (a). |
| Text-html ratio regression | Low | Refresh aggiunge testo (tagline + micro-copy + tile labels) → ratio sale. |
| Footer-root presence regression | Zero | `buildSeoPageHtml` shell invariata. |
| Title length regression | Zero | `<title>` non toccato. |
| BFS depth regression | Zero | Nessun nuovo link, link interni preservati. |
| Worktree merge conflict con altri agent paralleli | Medium | Worktree isolato dall'inizio; check `git status` plugin landing pre-start; se conflict, `rebase.autoStash true` (non `git stash -u` blanket). |
| GitNexus stale dopo rimozione `renderFeaturedJobCard` × 4 | Low | Pre-merge `gitnexus_impact` per ognuno; post-merge `npx gitnexus analyze` (hook). |
| Logo broken-image per aziende sconosciute | Mitigated | Catena fallback `jobCardHtml.ts` replicata in `employerCardHtml.ts` via `companyLogoResolver.ts` condiviso. |

## Success criteria

- [ ] `/lavoro-ticino-educatore/` mostra job cards visivamente identiche a quelle di `/job-board/case-anziani/` (canonical).
- [ ] Stesso vale per le altre 11 professioni + tutte le career/nursing/costOfLiving landings.
- [ ] Employer cards omogenee tra `professionLandings`, `careerLandings`, `nursingLandings`, `costOfLivingLandings` (compact), `weeklyEmployersPlugin` (detailed).
- [ ] Hero con emoji + tagline ≤120 char in tutti 4 locales.
- [ ] Stats tiles colorate solo via token semantici (zero hex inline).
- [ ] Mobile viewport 414px: tagline + tile + prima job card tutte sopra la fold.
- [ ] Tutti gli audit ratchet verdi.
- [ ] Test gate (4 nuovi vitest) attivi in CI.
- [ ] Zero pagine nuove generate (moratorium-respecting).

## Out of scope (followup candidates)

- Estendere il refresh stilistico a `jobSectorPagesPlugin` / `jobsSeoPagesPlugin` / `jobRecencyPagesPlugin` / `orphanQueryLandingPlugin` (canonical-card already, ma hero/tiles ancora sterili) — design separato.
- Animazioni più sofisticate (scroll-driven reveal, parallax) — esplicitamente rifiutate in scope.
- Logo upload manuale per top 50 brand frontalieri — separato, richiede asset pipeline.
- A/B test del nuovo layout vs vecchio — il rollout è full-cutover per coerenza visuale; A/B test post-fatto via PostHog se serve misurare CTR.
