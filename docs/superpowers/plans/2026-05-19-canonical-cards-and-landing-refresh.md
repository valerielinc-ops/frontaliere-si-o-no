# Canonical Cards Adoption + SEO Landing Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate 4 SEO-landing build plugins (profession/career/nursing/cost-of-living) + `weeklyEmployersPlugin` to a shared, canonical job-card and employer-card renderer; refresh the landings with emoji hero, semantic-color stats tiles, micro-copy, and a fade-in animation.

**Architecture:** Add 4 new modules under `build-plugins/shared/` (`companyLogoResolver.ts`, `employerCardHtml.ts`, `landingHeroPersonality.ts`, `landingMicroCopy.ts`). Extend `FeaturedJob` projections in 4 aggregates with the fields the canonical renderer needs (`contract`, `companyKey`, `companyDomain`, `url`, `addressLocality`). Replace inline `renderFeaturedJobCard()` and `renderEmployerGrid()` in each plugin with calls to the shared renderers. Layer hero/tiles/micro-copy/fade-in on top of the 4 landing plugins.

**Tech Stack:** TypeScript, Vite build plugins, Tailwind CSS (already scanning `./build-plugins/**/*.{js,ts}`), Vitest, `services/jobDataNormalization.ts` for logo resolution.

**Spec:** `docs/superpowers/specs/2026-05-19-valerielinc-canonical-cards-and-landing-refresh-design.md`

---

## Pre-flight (one-time setup)

### Task 0: Create isolated worktree

**Files:** none yet

- [ ] **Step 1: Verify clean state in shared tree**

Run: `git status --short build-plugins/ tests/build-plugins/ docs/superpowers/`
Expected: only `docs/superpowers/specs/2026-05-19-...` (already committed) or empty. If foreign WIP exists in any of those paths, STOP and ask the user — do not bundle it.

- [ ] **Step 2: Create worktree on new branch**

Use the `EnterWorktree` tool with:
- branch: `refactor/canonical-cards-and-landing-refresh`
- base: current branch (or `main` if asked)

The agent now operates inside the worktree. All subsequent file paths in this plan are relative to the worktree root (same layout as the main tree).

---

## Phase 1 — Infrastructure (shared modules, no behavior change yet)

### Task 1: Extract `companyLogoResolver.ts` from `jobCardHtml.ts`

Refactor: move logo resolution helpers into a new shared module so both `jobCardHtml.ts` and the new `employerCardHtml.ts` import from one place. Zero behavior change.

**Files:**
- Create: `build-plugins/shared/companyLogoResolver.ts`
- Modify: `build-plugins/shared/jobCardHtml.ts` (remove duplicated helpers, import them)
- Test: `tests/build-plugins/company-logo-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/build-plugins/company-logo-resolver.test.ts
import { describe, it, expect } from 'vitest';
import {
  resolveJobLogoSrc,
  generateInitialsLogo,
  LOGO_FALLBACK_SRC,
} from '../../build-plugins/shared/companyLogoResolver';

describe('companyLogoResolver', () => {
  it('returns explicit logo override when present', () => {
    expect(
      resolveJobLogoSrc({ company: 'X', logo: 'https://cdn/x.png' }),
    ).toBe('https://cdn/x.png');
  });

  it('falls back to deterministic initials SVG when no host is known', () => {
    const src = resolveJobLogoSrc({ company: 'Acme Pizza' });
    expect(src).toMatch(/^data:image\/svg\+xml/);
    expect(decodeURIComponent(src)).toContain('AP');
  });

  it('returns the placeholder when neither logo nor company name exist', () => {
    expect(resolveJobLogoSrc({})).toBe(LOGO_FALLBACK_SRC);
  });

  it('generates stable initials for the same input', () => {
    expect(generateInitialsLogo('Migros')).toBe(generateInitialsLogo('Migros'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/build-plugins/company-logo-resolver.test.ts`
Expected: FAIL — module not found at `build-plugins/shared/companyLogoResolver.ts`.

- [ ] **Step 3: Create the new module**

```typescript
// build-plugins/shared/companyLogoResolver.ts
/**
 * Shared logo resolution helpers used by jobCardHtml.ts and employerCardHtml.ts.
 * Extracted to avoid duplication. Mirrors the SPA `companyLogoUrl` chain in
 * components/community/JobBoard.tsx and services/logoService.ts.
 */
import {
  resolveCompanyLogoUrl,
  resolveCompanyWebsiteHost,
} from '../../services/jobDataNormalization';

export const LOGO_FALLBACK_SRC = '/images/company-logo-fallback.svg';

const INITIALS_PALETTE: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: '#dbeafe', fg: '#1e40af' },
  { bg: '#dcfce7', fg: '#166534' },
  { bg: '#fef3c7', fg: '#92400e' },
  { bg: '#fce7f3', fg: '#9d174d' },
  { bg: '#e0e7ff', fg: '#3730a3' },
  { bg: '#f3e8ff', fg: '#6b21a8' },
  { bg: '#fee2e2', fg: '#991b1b' },
  { bg: '#ccfbf1', fg: '#115e59' },
];

export function generateInitialsLogo(company: string): string {
  const cleaned = company.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  const initials = words.length === 0
    ? '?'
    : words.length === 1
      ? words[0].slice(0, 2).toUpperCase()
      : (words[0][0] + words[1][0]).toUpperCase();
  let hash = 0;
  for (let i = 0; i < cleaned.length; i++) hash = (hash * 31 + cleaned.charCodeAt(i)) >>> 0;
  const palette = INITIALS_PALETTE[hash % INITIALS_PALETTE.length];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">` +
    `<rect width="40" height="40" rx="8" fill="${palette.bg}"/>` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="16" font-weight="700" fill="${palette.fg}">` +
    `${initials}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export interface LogoLookupShape {
  company?: string;
  companyKey?: string;
  companyDomain?: string;
  url?: string;
  logo?: string | null;
}

/**
 * Logo resolution chain:
 *   1. Explicit `logo` override.
 *   2. Curated CRAWLED_COMPANY_LOGOS / domain-derived favicon.
 *   3. Google favicon by host.
 *   4. Deterministic coloured-initials SVG.
 *   5. Generic placeholder.
 */
export function resolveJobLogoSrc(job: LogoLookupShape): string {
  if (job.logo && typeof job.logo === 'string' && job.logo.trim().length > 0) {
    return job.logo;
  }
  const resolved = resolveCompanyLogoUrl(job);
  if (resolved && resolved.length > 0) return resolved;
  const host = resolveCompanyWebsiteHost(job);
  if (host) {
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
  }
  if (job.company && String(job.company).trim().length > 0) {
    return generateInitialsLogo(String(job.company));
  }
  return LOGO_FALLBACK_SRC;
}
```

- [ ] **Step 4: Update `jobCardHtml.ts` to use the new module**

Open `build-plugins/shared/jobCardHtml.ts`. Replace lines 172-245 (the `LOGO_FALLBACK_SRC` constant, `INITIALS_PALETTE`, `generateInitialsLogo`, `resolveJobCardLogo`) with a single import block at the top of the file:

```typescript
// Replace the existing imports block (lines 19-23) with:
import {
  resolveJobLogoSrc as resolveJobCardLogo,
  generateInitialsLogo,
  LOGO_FALLBACK_SRC,
} from './companyLogoResolver';
```

And delete the body of those helpers (lines 174-245 in the current file). Re-export `resolveJobCardLogo` so existing consumers (if any) keep working:

```typescript
export { resolveJobCardLogo };
```

- [ ] **Step 5: Run the new test and the jobCardHtml tests**

Run: `npx vitest run tests/build-plugins/company-logo-resolver.test.ts tests/build-plugins/job-card-html.test.ts 2>/dev/null; npx vitest run tests/build-plugins/`
Expected: ALL PASS. If `tests/build-plugins/job-card-html.test.ts` doesn't exist yet, only the new test runs.

- [ ] **Step 6: Run the type-check**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add build-plugins/shared/companyLogoResolver.ts build-plugins/shared/jobCardHtml.ts tests/build-plugins/company-logo-resolver.test.ts
git commit -m "refactor(build): extract companyLogoResolver from jobCardHtml"
```

---

### Task 2: Create `employerCardHtml.ts` + tests

**Files:**
- Create: `build-plugins/shared/employerCardHtml.ts`
- Test: `tests/build-plugins/employer-card-html.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/build-plugins/employer-card-html.test.ts
import { describe, it, expect } from 'vitest';
import {
  renderEmployerCardHtml,
  renderEmployerCardListHtml,
} from '../../build-plugins/shared/employerCardHtml';

describe('renderEmployerCardHtml (compact)', () => {
  const employer = {
    name: 'Migros Ticino',
    companyKey: 'migros',
    companyDomain: 'migros.ch',
    openings: 12,
  };

  it('renders a card with logo slot, name, and openings count', () => {
    const html = renderEmployerCardHtml(employer, {
      href: '/aziende/migros',
      locale: 'it',
      variant: 'compact',
    });
    expect(html).toContain('href="/aziende/migros"');
    expect(html).toContain('Migros Ticino');
    expect(html).toMatch(/<img[^>]+alt="Logo Migros Ticino"/);
    expect(html).toContain('>12<');
  });

  it('omits openings count when null', () => {
    const html = renderEmployerCardHtml(
      { ...employer, openings: null },
      { href: '/x', locale: 'it', variant: 'compact' },
    );
    expect(html).not.toMatch(/>0</);
  });

  it('uses bg-surface-raised + border-edge (Tailwind tokens, no inline hex)', () => {
    const html = renderEmployerCardHtml(employer, {
      href: '/x',
      locale: 'it',
      variant: 'compact',
    });
    expect(html).toContain('bg-surface-raised');
    expect(html).toContain('border-edge');
    expect(html).not.toMatch(/style="[^"]*background-color:\s*#/);
  });

  it('escapes HTML in employer name', () => {
    const html = renderEmployerCardHtml(
      { name: '<script>x</script>' },
      { href: '/x', locale: 'it', variant: 'compact' },
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('renderEmployerCardHtml (detailed)', () => {
  it('renders sector + city + openings in the detailed variant', () => {
    const html = renderEmployerCardHtml(
      {
        name: 'Lonza',
        companyKey: 'lonza',
        companyDomain: 'lonza.com',
        sector: 'Farmaceutica',
        city: 'Visp',
        openings: 35,
      },
      { href: '/aziende/lonza-visp', locale: 'it', variant: 'detailed' },
    );
    expect(html).toContain('Farmaceutica');
    expect(html).toContain('Visp');
    expect(html).toContain('35');
  });
});

describe('renderEmployerCardListHtml', () => {
  it('renders <ul role="list"> with one <li> per employer', () => {
    const html = renderEmployerCardListHtml(
      [
        { employer: { name: 'A' }, href: '/a' },
        { employer: { name: 'B' }, href: '/b' },
      ],
      { locale: 'it', variant: 'compact' },
    );
    expect(html).toMatch(/<ul[^>]+role="list"/);
    expect((html.match(/<li>/g) || []).length).toBe(2);
  });

  it('returns emptyStateHtml when list is empty', () => {
    const html = renderEmployerCardListHtml([], {
      locale: 'it',
      variant: 'compact',
      emptyStateHtml: '<p>nessuno</p>',
    });
    expect(html).toBe('<p>nessuno</p>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/build-plugins/employer-card-html.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the new module**

```typescript
// build-plugins/shared/employerCardHtml.ts
/**
 * Shared HTML renderer for employer cards used across SEO landing-page plugins.
 * Two variants: `compact` (grid in profession/career/nursing/costOfLiving
 * landings) and `detailed` (weeklyEmployersPlugin company cards).
 *
 * Mirrors the visual language of jobCardHtml.ts — same Tailwind tokens
 * (`bg-surface-raised`, `border-edge`, `text-heading`, etc.), same logo
 * fallback chain via companyLogoResolver. Build plugins are scanned by
 * Tailwind (`./build-plugins/**/*.{js,ts}` in tailwind.config.js) so every
 * class used here is preserved in the production CSS bundle.
 */
import {
  resolveJobLogoSrc,
  generateInitialsLogo,
  LOGO_FALLBACK_SRC,
} from './companyLogoResolver';

export type EmployerCardLocale = 'it' | 'en' | 'de' | 'fr';

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
  locale: EmployerCardLocale;
  variant?: 'compact' | 'detailed';
  openingsLabel?: (n: number) => string;
}

function escHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OPENINGS_DEFAULT_LABEL: Record<EmployerCardLocale, (n: number) => string> = {
  it: (n) => (n === 1 ? '1 posto' : `${n} posti`),
  en: (n) => (n === 1 ? '1 opening' : `${n} openings`),
  de: (n) => (n === 1 ? '1 Stelle' : `${n} Stellen`),
  fr: (n) => (n === 1 ? '1 poste' : `${n} postes`),
};

function renderLogoSlot(e: EmployerCardEmployer, sizeClass: string): string {
  const safeAlt = escHtml(`Logo ${e.name}`);
  const logoSrc = resolveJobLogoSrc({
    company: e.name,
    companyKey: e.companyKey,
    companyDomain: e.companyDomain,
    url: e.url,
    logo: e.logo,
  });
  const fallbackSrc = e.name ? generateInitialsLogo(e.name) : LOGO_FALLBACK_SRC;
  const onerror = `this.onerror=null;this.src=&quot;${escHtml(fallbackSrc)}&quot;`;
  return `<div class="${sizeClass} rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden border border-edge shrink-0"><img alt="${safeAlt}" class="w-7 h-7 sm:w-9 sm:h-9 object-contain" width="40" height="40" loading="lazy" src="${escHtml(logoSrc)}" onerror="${onerror}"></div>`;
}

export function renderEmployerCardHtml(
  e: EmployerCardEmployer,
  opts: EmployerCardOptions,
): string {
  const variant = opts.variant ?? 'compact';
  const openingsLbl = opts.openingsLabel ?? OPENINGS_DEFAULT_LABEL[opts.locale];
  const openingsHtml = typeof e.openings === 'number' && e.openings > 0
    ? `<span class="font-bold text-accent tabular-nums shrink-0">${escHtml(String(e.openings))}</span>`
    : '';

  if (variant === 'detailed') {
    const sectorChip = e.sector
      ? `<span class="px-1.5 py-0.5 rounded bg-surface-raised text-subtle text-xs">${escHtml(e.sector)}</span>`
      : '';
    const cityChip = e.city
      ? `<span class="text-xs text-subtle">${escHtml(e.city)}</span>`
      : '';
    const openingsLine = typeof e.openings === 'number' && e.openings > 0
      ? `<p class="text-sm text-success font-semibold mt-1">${escHtml(openingsLbl(e.openings))}</p>`
      : '';
    return `<article class="rounded-xl border border-edge bg-surface/50 hover:border-accent-border transition-colors p-3 sm:p-4"><a href="${escHtml(opts.href)}" class="block focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg"><div class="flex items-start gap-3">${renderLogoSlot(e, 'w-12 h-12 sm:w-14 sm:h-14')}<div class="min-w-0 flex-1"><h3 class="text-sm sm:text-base font-bold font-display text-heading leading-tight">${escHtml(e.name)}</h3><div class="mt-1 flex flex-wrap items-center gap-2">${sectorChip}${cityChip}</div>${openingsLine}</div></div></a></article>`;
  }

  // compact (default)
  return `<a href="${escHtml(opts.href)}" class="flex items-center gap-2.5 rounded-xl border border-edge bg-surface/50 p-3 hover:border-accent-border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent text-inherit no-underline">${renderLogoSlot(e, 'w-9 h-9 sm:w-10 sm:h-10')}<div class="flex-1 min-w-0"><div class="font-bold text-sm text-heading leading-tight truncate">${escHtml(e.name)}</div></div>${openingsHtml}</a>`;
}

export interface EmployerCardListItem {
  employer: EmployerCardEmployer;
  href: string;
}

export interface EmployerCardListOptions {
  locale: EmployerCardLocale;
  variant?: 'compact' | 'detailed';
  ulClassName?: string;
  emptyStateHtml?: string;
  openingsLabel?: (n: number) => string;
}

const DEFAULT_UL_COMPACT = 'list-none p-0 m-0 grid gap-2.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
const DEFAULT_UL_DETAILED = 'list-none p-0 m-0 grid gap-3';

export function renderEmployerCardListHtml(
  items: ReadonlyArray<EmployerCardListItem>,
  opts: EmployerCardListOptions,
): string {
  if (items.length === 0) return opts.emptyStateHtml ?? '';
  const variant = opts.variant ?? 'compact';
  const ulClass = opts.ulClassName ?? (variant === 'detailed' ? DEFAULT_UL_DETAILED : DEFAULT_UL_COMPACT);
  const cards = items
    .map(({ employer, href }) =>
      `<li>${renderEmployerCardHtml(employer, {
        href,
        locale: opts.locale,
        variant,
        openingsLabel: opts.openingsLabel,
      })}</li>`,
    )
    .join('');
  return `<ul role="list" class="${escHtml(ulClass)}">${cards}</ul>`;
}
```

- [ ] **Step 4: Run tests + type-check**

Run: `npx vitest run tests/build-plugins/employer-card-html.test.ts && npx tsc --noEmit`
Expected: ALL PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/shared/employerCardHtml.ts tests/build-plugins/employer-card-html.test.ts
git commit -m "feat(build): add shared employerCardHtml renderer (compact + detailed)"
```

---

### Task 3: Create `landingHeroPersonality.ts` + tests

**Files:**
- Create: `build-plugins/shared/landingHeroPersonality.ts`
- Test: `tests/build-plugins/landing-hero-personality.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/build-plugins/landing-hero-personality.test.ts
import { describe, it, expect } from 'vitest';
import {
  HERO_BADGES,
  renderLandingHero,
  type HeroVars,
} from '../../build-plugins/shared/landingHeroPersonality';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

describe('HERO_BADGES coverage', () => {
  it('includes all 10 profession ids', () => {
    const required = [
      'infermiere', 'operaio', 'impiegato', 'ingegnere', 'educatore',
      'autista', 'muratore', 'cuoco', 'cameriere', 'elettricista',
    ];
    for (const id of required) {
      expect(HERO_BADGES, `missing badge for ${id}`).toHaveProperty(id);
    }
  });

  it('every badge has emoji + all 4 locale eyebrows + all 4 locale taglines', () => {
    for (const [id, badge] of Object.entries(HERO_BADGES)) {
      expect(badge.emoji.length, `${id} emoji empty`).toBeGreaterThan(0);
      for (const loc of LOCALES) {
        expect(badge.eyebrowLabel[loc], `${id}.eyebrowLabel.${loc}`).toBeTruthy();
        expect(badge.taglineTemplate[loc], `${id}.taglineTemplate.${loc}`).toBeTypeOf('function');
      }
    }
  });
});

describe('tagline length budget', () => {
  const realisticVars: HeroVars = { openings: 47, medianSalary: 65000, city: 'Lugano' };

  it('every tagline is ≤120 chars in every locale', () => {
    for (const [id, badge] of Object.entries(HERO_BADGES)) {
      for (const loc of LOCALES) {
        const out = badge.taglineTemplate[loc](realisticVars);
        expect(
          out.length,
          `${id}/${loc} tagline >120 chars: "${out}" (${out.length})`,
        ).toBeLessThanOrEqual(120);
      }
    }
  });

  it('survives missing medianSalary', () => {
    for (const [id, badge] of Object.entries(HERO_BADGES)) {
      for (const loc of LOCALES) {
        const out = badge.taglineTemplate[loc]({ openings: 5 });
        expect(out.length).toBeGreaterThan(0);
        expect(out.length).toBeLessThanOrEqual(120);
      }
    }
  });
});

describe('renderLandingHero', () => {
  it('emits eyebrow + h1 + tagline in mobile-first order', () => {
    const html = renderLandingHero(
      'educatore',
      'it',
      { openings: 47, medianSalary: 65000 },
      'Lavoro come educatore in Ticino',
    );
    const eyebrowIdx = html.indexOf('Educatore');
    const h1Idx = html.indexOf('<h1');
    const taglineIdx = html.indexOf('bambini');
    expect(eyebrowIdx).toBeGreaterThan(-1);
    expect(h1Idx).toBeGreaterThan(eyebrowIdx);
    expect(taglineIdx).toBeGreaterThan(h1Idx);
  });

  it('uses semantic colour tokens (no inline hex)', () => {
    const html = renderLandingHero('educatore', 'it', { openings: 5 }, 'X');
    expect(html).toContain('text-accent');
    expect(html).not.toMatch(/style="[^"]*color:\s*#/);
  });

  it('renders eyebrow emoji aria-hidden', () => {
    const html = renderLandingHero('educatore', 'it', { openings: 5 }, 'X');
    expect(html).toMatch(/<span aria-hidden="true">🎓<\/span>/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/build-plugins/landing-hero-personality.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the new module with all 10 profession entries**

```typescript
// build-plugins/shared/landingHeroPersonality.ts
/**
 * Per-landing hero personality: emoji + eyebrow + tagline.
 * Used by profession/career/nursing/costOfLiving landing plugins.
 *
 * Tagline budget: ≤120 chars across all locales (enforced by vitest).
 * Emoji palette: curated, universal-coverage emoji (🎓🚑🍳⚙️👶📊🏗️💼🩺🏠🚛🍽️🔌).
 */

export type HeroLocale = 'it' | 'en' | 'de' | 'fr';

export interface HeroVars {
  openings: number;
  medianSalary?: number;
  city?: string;
}

export interface LandingHeroBadge {
  emoji: string;
  eyebrowLabel: Record<HeroLocale, string>;
  taglineTemplate: Record<HeroLocale, (v: HeroVars) => string>;
}

function chf(n?: number): string {
  return n ? `~CHF ${Math.round(n / 1000)}k` : '';
}

function withSalary(prefix: string, v: HeroVars, locale: HeroLocale): string {
  if (!v.medianSalary) return `${prefix}.`;
  const salaryWord: Record<HeroLocale, string> = {
    it: 'mediana',
    en: 'median',
    de: 'Median',
    fr: 'médian',
  };
  return `${prefix}, ${chf(v.medianSalary)} ${salaryWord[locale]}.`;
}

export const HERO_BADGES: Record<string, LandingHeroBadge> = {
  // ── PROFESSION_IDS (10) ────────────────────────────────────────────────
  infermiere: {
    emoji: '🩺',
    eyebrowLabel: {
      it: 'Professione · Infermiere in Ticino',
      en: 'Profession · Nurse in Ticino',
      de: 'Beruf · Krankenpfleger im Tessin',
      fr: 'Métier · Infirmier au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Case anziani, ospedali, cliniche: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Care homes, hospitals, clinics: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Pflegeheime, Spitäler, Kliniken: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`EMS, hôpitaux, cliniques: ${v.openings} postes`, v, 'fr'),
    },
  },
  operaio: {
    emoji: '⚙️',
    eyebrowLabel: {
      it: 'Professione · Operaio in Ticino',
      en: 'Profession · Worker in Ticino',
      de: 'Beruf · Arbeiter im Tessin',
      fr: 'Métier · Ouvrier au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Industria, manifattura, cantieri: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Industry, manufacturing, sites: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Industrie, Fertigung, Baustellen: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Industrie, fabrication, chantiers: ${v.openings} postes`, v, 'fr'),
    },
  },
  impiegato: {
    emoji: '💼',
    eyebrowLabel: {
      it: 'Professione · Impiegato in Ticino',
      en: 'Profession · Office clerk in Ticino',
      de: 'Beruf · Angestellter im Tessin',
      fr: 'Métier · Employé au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Uffici, amministrazione, banche: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Offices, admin, banks: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Büros, Verwaltung, Banken: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Bureaux, admin, banques: ${v.openings} postes`, v, 'fr'),
    },
  },
  ingegnere: {
    emoji: '📐',
    eyebrowLabel: {
      it: 'Professione · Ingegnere in Ticino',
      en: 'Profession · Engineer in Ticino',
      de: 'Beruf · Ingenieur im Tessin',
      fr: 'Métier · Ingénieur au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Software, civile, meccanica: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Software, civil, mechanical: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Software, Bau, Maschinen: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Logiciel, civil, mécanique: ${v.openings} postes`, v, 'fr'),
    },
  },
  educatore: {
    emoji: '🎓',
    eyebrowLabel: {
      it: 'Professione · Educatore in Ticino',
      en: 'Profession · Educator in Ticino',
      de: 'Beruf · Erzieher im Tessin',
      fr: 'Métier · Éducateur au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Lavoro con bambini e ragazzi: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Working with kids & teens: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Mit Kindern & Jugendlichen: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Avec enfants & ados: ${v.openings} postes`, v, 'fr'),
    },
  },
  autista: {
    emoji: '🚛',
    eyebrowLabel: {
      it: 'Professione · Autista in Ticino',
      en: 'Profession · Driver in Ticino',
      de: 'Beruf · Fahrer im Tessin',
      fr: 'Métier · Chauffeur au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Camion, bus, consegne: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Trucks, buses, delivery: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`LKW, Bus, Lieferung: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Camions, bus, livraison: ${v.openings} postes`, v, 'fr'),
    },
  },
  muratore: {
    emoji: '🏗️',
    eyebrowLabel: {
      it: 'Professione · Muratore in Ticino',
      en: 'Profession · Mason in Ticino',
      de: 'Beruf · Maurer im Tessin',
      fr: 'Métier · Maçon au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Cantieri, edilizia, restauro: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Construction sites, building: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Baustellen, Bauwesen: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Chantiers, bâtiment: ${v.openings} postes`, v, 'fr'),
    },
  },
  cuoco: {
    emoji: '🍳',
    eyebrowLabel: {
      it: 'Professione · Cuoco in Ticino',
      en: 'Profession · Cook in Ticino',
      de: 'Beruf · Koch im Tessin',
      fr: 'Métier · Cuisinier au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Ristoranti, hotel, mense: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Restaurants, hotels, canteens: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Restaurants, Hotels, Mensen: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Restos, hôtels, cantines: ${v.openings} postes`, v, 'fr'),
    },
  },
  cameriere: {
    emoji: '🍽️',
    eyebrowLabel: {
      it: 'Professione · Cameriere in Ticino',
      en: 'Profession · Waiter in Ticino',
      de: 'Beruf · Kellner im Tessin',
      fr: 'Métier · Serveur au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Sala, bar, banchetti: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Dining, bar, banquets: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Saal, Bar, Bankette: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Salle, bar, banquets: ${v.openings} postes`, v, 'fr'),
    },
  },
  elettricista: {
    emoji: '🔌',
    eyebrowLabel: {
      it: 'Professione · Elettricista in Ticino',
      en: 'Profession · Electrician in Ticino',
      de: 'Beruf · Elektriker im Tessin',
      fr: 'Métier · Électricien au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Impianti, manutenzione, cantieri: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Wiring, maintenance, sites: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Anlagen, Wartung, Baustellen: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Installations, sites: ${v.openings} postes`, v, 'fr'),
    },
  },
};

/**
 * Render the canonical hero block: eyebrow (emoji + label), h1, tagline.
 * Mobile-first per CLAUDE.md non-negotiable #17. The tagline is ≤120 chars
 * (enforced by vitest landing-hero-personality.test.ts).
 *
 * If `id` is unknown, returns a minimal hero (h1 + tagline derived from
 * `fallbackTagline` if provided, else empty) — fail-soft for landings
 * without an entry yet.
 */
export function renderLandingHero(
  id: string,
  locale: HeroLocale,
  vars: HeroVars,
  title: string,
  fallbackTagline?: string,
): string {
  const badge = HERO_BADGES[id];
  const eyebrow = badge
    ? `<p class="text-sm font-semibold text-accent flex items-center gap-1.5"><span aria-hidden="true">${badge.emoji}</span>${escHtml(badge.eyebrowLabel[locale])}</p>`
    : '';
  const tagline = badge
    ? badge.taglineTemplate[locale](vars)
    : (fallbackTagline ?? '');
  const taglineHtml = tagline
    ? `<p class="text-base text-body mt-2 max-w-prose">${escHtml(tagline)}</p>`
    : '';
  return `<header>${eyebrow}<h1 class="text-2xl sm:text-3xl font-display font-bold text-heading mt-2">${escHtml(title)}</h1>${taglineHtml}</header>`;
}

function escHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
```

- [ ] **Step 4: Run tests + type-check**

Run: `npx vitest run tests/build-plugins/landing-hero-personality.test.ts && npx tsc --noEmit`
Expected: ALL PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/shared/landingHeroPersonality.ts tests/build-plugins/landing-hero-personality.test.ts
git commit -m "feat(build): add landingHeroPersonality with 10 profession badges"
```

---

### Task 4: Create `landingMicroCopy.ts` + tests

**Files:**
- Create: `build-plugins/shared/landingMicroCopy.ts`
- Test: `tests/build-plugins/landing-micro-copy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/build-plugins/landing-micro-copy.test.ts
import { describe, it, expect } from 'vitest';
import {
  pickEmptyState,
  pickCtaAllJobs,
  EMPTY_FEATURED_JOBS,
  CTA_ALL_JOBS,
} from '../../build-plugins/shared/landingMicroCopy';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

describe('landingMicroCopy length budget', () => {
  it('every empty-state message ≤140 chars', () => {
    for (const loc of LOCALES) {
      for (const msg of EMPTY_FEATURED_JOBS[loc]) {
        expect(msg.length, `empty/${loc}: "${msg}"`).toBeLessThanOrEqual(140);
      }
    }
  });

  it('every CTA, rendered with N=99, ≤80 chars', () => {
    for (const loc of LOCALES) {
      for (const tpl of CTA_ALL_JOBS[loc]) {
        const out = tpl(99);
        expect(out.length, `cta/${loc}: "${out}"`).toBeLessThanOrEqual(80);
        expect(out, `cta/${loc} missing N`).toContain('99');
      }
    }
  });
});

describe('deterministic selection', () => {
  it('same (id, locale) always picks same empty message', () => {
    const a = pickEmptyState('educatore', 'it');
    const b = pickEmptyState('educatore', 'it');
    expect(a).toBe(b);
  });

  it('same (id, locale, count) always picks same CTA', () => {
    const a = pickCtaAllJobs('educatore', 'it', 47);
    const b = pickCtaAllJobs('educatore', 'it', 47);
    expect(a).toBe(b);
    expect(a).toContain('47');
  });

  it('different ids may pick different messages (variety check)', () => {
    const ids = ['infermiere', 'operaio', 'impiegato', 'ingegnere', 'educatore', 'autista', 'muratore', 'cuoco', 'cameriere', 'elettricista'];
    const picks = new Set(ids.map((id) => pickEmptyState(id, 'it')));
    expect(picks.size, 'expected at least 2 distinct empty messages across 10 ids').toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/build-plugins/landing-micro-copy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the new module**

```typescript
// build-plugins/shared/landingMicroCopy.ts
/**
 * Curated micro-copy for SEO landings: empty-states + "see all jobs" CTAs.
 * Deterministic per-(id × locale) selection via hash so the same page
 * always renders the same string (no build-to-build flicker), but
 * different landings get variety.
 */

export type MicroCopyLocale = 'it' | 'en' | 'de' | 'fr';

export const EMPTY_FEATURED_JOBS: Record<MicroCopyLocale, ReadonlyArray<string>> = {
  it: [
    'Per ora nessuna offerta: torna lunedì, le aziende caricano dopo il weekend.',
    'Categoria silenziosa oggi. Iscriviti alla newsletter per essere il primo a saperlo.',
    'Zero annunci freschi qui — ma il tuo CV potrebbe già fare la differenza.',
    'Niente da mostrare ora. I crawler passano due volte al giorno, ripassa più tardi.',
  ],
  en: [
    "No openings right now — come back Monday, employers post after the weekend.",
    'Quiet category today. Subscribe to the newsletter to hear it first.',
    "Zero fresh listings here — your CV could still be the right answer.",
    'Nothing to show now. Our crawlers run twice a day, check back later.',
  ],
  de: [
    'Aktuell keine Stellen — Montag schauen die Firmen meist neue Angebote rein.',
    'Heute ruhige Kategorie. Newsletter abonnieren und als Erster erfahren.',
    'Keine frischen Anzeigen — dein CV könnte trotzdem die Antwort sein.',
    'Gerade nichts. Unsere Crawler laufen zweimal täglich, später wiederkommen.',
  ],
  fr: [
    'Aucune offre pour l’instant — repassez lundi, les entreprises publient après le weekend.',
    'Catégorie calme aujourd’hui. Inscrivez-vous à la newsletter pour être averti.',
    'Zéro annonce fraîche ici — votre CV peut quand même faire mouche.',
    'Rien à montrer maintenant. Les crawlers passent deux fois par jour.',
  ],
};

export const CTA_ALL_JOBS: Record<MicroCopyLocale, ReadonlyArray<(n: number) => string>> = {
  it: [
    (n) => `Vedi tutti i ${n} annunci →`,
    (n) => `Sfoglia i ${n} posti aperti →`,
    (n) => `Apri tutte le ${n} offerte →`,
  ],
  en: [
    (n) => `See all ${n} listings →`,
    (n) => `Browse ${n} openings →`,
    (n) => `Open all ${n} jobs →`,
  ],
  de: [
    (n) => `Alle ${n} Anzeigen anzeigen →`,
    (n) => `${n} offene Stellen durchstöbern →`,
    (n) => `Alle ${n} Jobs öffnen →`,
  ],
  fr: [
    (n) => `Voir les ${n} annonces →`,
    (n) => `Parcourir ${n} postes ouverts →`,
    (n) => `Ouvrir les ${n} offres →`,
  ],
};

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function pickEmptyState(id: string, locale: MicroCopyLocale): string {
  const pool = EMPTY_FEATURED_JOBS[locale];
  return pool[hash(`${id}|${locale}`) % pool.length];
}

export function pickCtaAllJobs(id: string, locale: MicroCopyLocale, count: number): string {
  const pool = CTA_ALL_JOBS[locale];
  const tpl = pool[hash(`${id}|${locale}|cta`) % pool.length];
  return tpl(count);
}
```

- [ ] **Step 4: Run tests + type-check**

Run: `npx vitest run tests/build-plugins/landing-micro-copy.test.ts && npx tsc --noEmit`
Expected: ALL PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/shared/landingMicroCopy.ts tests/build-plugins/landing-micro-copy.test.ts
git commit -m "feat(build): add landingMicroCopy (empty-state + CTA pools)"
```

---

## Phase 2 — Snapshot enrichment

### Task 5: Extend `FeaturedJob` projections in 4 aggregates

Add the fields needed by the canonical `JobCardJob`: `contract`, `companyKey`, `companyDomain`, `url`, `addressLocality`. `postedDate` is already present.

**Files:**
- Modify: `build-plugins/professionJobsAggregate.ts` (interface ~line 58, projector ~line 200)
- Modify: `build-plugins/careerJobsAggregate.ts` (interface `CareerFeaturedJob` ~line 56)
- Modify: `build-plugins/cityJobsAggregate.ts` (interface `CityFeaturedJob` ~line 62)
- Modify: `build-plugins/nursingJobsAggregate.ts` (re-exports `FeaturedJob`, inherits automatically — but the projector at line 153 needs to populate new fields)

- [ ] **Step 1: Open `professionJobsAggregate.ts` and read interface + projector**

Run: `grep -n "FeaturedJob\|toFeatured\|featured.push" build-plugins/professionJobsAggregate.ts | head`

Locate `JobRecord` interface (~line 35) and `FeaturedJob` interface (~line 58) and the projection function (search for `titleByLocale: job.titleByLocale ?? {}` near line 216).

- [ ] **Step 2: Extend `JobRecord` if fields aren't already there**

In `JobRecord` (~line 35), confirm these fields exist and add any missing:

```typescript
interface JobRecord {
  id?: string;
  slug?: string;
  slugByLocale?: Partial<Record<ProfessionLocale, string>>;
  title?: string;
  titleByLocale?: Partial<Record<ProfessionLocale, string>>;
  company?: string;
  companyKey?: string;
  companyDomain?: string;        // ADD if missing
  category?: string;
  sector?: string;
  addressLocality?: string;
  canton?: string;
  contract?: string;             // ADD if missing
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string;
  postedDate?: string;
  firstSeenAt?: string;
  featured?: boolean;
  employmentType?: string;
  url?: string;
  applyUrl?: string;
}
```

- [ ] **Step 3: Extend `FeaturedJob` interface in `professionJobsAggregate.ts`**

Replace the existing `FeaturedJob` block (lines 58-71) with:

```typescript
export interface FeaturedJob {
  readonly id: string;
  readonly title: string;
  readonly titleByLocale: Partial<Record<ProfessionLocale, string>>;
  readonly company: string;
  readonly companyKey: string | null;
  readonly companyDomain: string | null;
  readonly city: string;
  readonly addressLocality: string | null;
  readonly canton: string | null;
  readonly contract: string | null;
  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  readonly postedDate: string;
  readonly daysAgo: number;
  readonly slug: string;
  readonly slugByLocale: Partial<Record<ProfessionLocale, string>>;
  readonly employmentType: string | null;
  readonly url: string | null;
}
```

- [ ] **Step 4: Update the projector to populate the new fields**

Find the object returned around line 216 (`titleByLocale: job.titleByLocale ?? {},`). Add the new fields:

```typescript
return {
  id: job.id ?? '',
  title: job.title ?? '',
  titleByLocale: job.titleByLocale ?? {},
  company: job.company ?? '',
  companyKey: job.companyKey ?? null,
  companyDomain: job.companyDomain ?? null,
  city: addressLocality,             // existing local var, keep
  addressLocality: job.addressLocality ?? null,
  canton: job.canton ?? null,
  contract: job.employmentType ?? job.contract ?? null,
  salaryMin: typeof job.salaryMin === 'number' ? job.salaryMin : null,
  salaryMax: typeof job.salaryMax === 'number' ? job.salaryMax : null,
  postedDate,
  daysAgo,
  slug: job.slug ?? '',
  slugByLocale: job.slugByLocale ?? {},
  employmentType: job.employmentType ?? null,
  url: job.url ?? null,
};
```

(Adapt to match the exact local-variable names already in the file — the field names are what matter.)

- [ ] **Step 5: Repeat the interface + projector extension for the other 3 aggregates**

For each of:
- `build-plugins/careerJobsAggregate.ts` (interface `CareerFeaturedJob` ~line 56)
- `build-plugins/cityJobsAggregate.ts` (interface `CityFeaturedJob` ~line 62)

Add the same 6 new fields (`companyKey`, `companyDomain`, `addressLocality`, `canton`, `contract`, `url`) to the interface AND populate them in the projector. Use `null` as the default when the source `JobRecord` doesn't have the field.

For `build-plugins/nursingJobsAggregate.ts`: the type is `export type NursingFeaturedJob = FeaturedJob;` (re-exported from professionJobsAggregate) — so the interface change is automatic. **But the projector at line 153 (`toFeatured`) needs to be updated to populate the new fields with the same shape as the profession projector.**

- [ ] **Step 6: Run type-check**

Run: `npx tsc --noEmit`
Expected: 0 errors. If something downstream consumed the old narrow `FeaturedJob` shape, TS will surface it — fix by either ignoring the new optional fields (they're additive) or updating the consumer.

- [ ] **Step 7: Run all build-plugin tests**

Run: `npx vitest run tests/build-plugins/`
Expected: ALL PASS. If any existing snapshot test compares serialized `FeaturedJob` JSON, it will fail — update the expected snapshot to include the new fields, then re-run.

- [ ] **Step 8: Commit**

```bash
git add build-plugins/professionJobsAggregate.ts build-plugins/careerJobsAggregate.ts build-plugins/cityJobsAggregate.ts build-plugins/nursingJobsAggregate.ts tests/
git commit -m "feat(build): extend FeaturedJob with contract/companyKey/domain/url/canton"
```

---

## Phase 3 — Migrate job cards (4 plugins)

### Task 6: Migrate `professionLandingsPlugin.ts` job cards to canonical

**Files:**
- Modify: `build-plugins/professionLandingsPlugin.ts` (lines 166-210 — `renderFeaturedJobCard` + `renderFeaturedJobs`)

- [ ] **Step 1: Add the failing canonical-adoption test**

Create `tests/build-plugins/job-card-canonical-adoption.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// Helper: call the plugin's renderFeaturedJobs with a fixture and assert the
// resulting HTML contains markers unique to the canonical renderer.

const CANONICAL_MARKERS = [
  /<article class="rounded-xl border p-3 sm:p-4/,
  /<div class="w-10 h-10 sm:w-14 sm:h-14 rounded-lg/,
  /class="lucide lucide-map-pin/,
  /data-posted="/,
];

const FIXTURE_JOB = {
  id: 'job-1',
  title: 'Educatore prima infanzia',
  titleByLocale: { it: 'Educatore prima infanzia' },
  company: 'Asilo Sole',
  companyKey: 'asilo-sole',
  companyDomain: 'asilosole.ch',
  city: 'Lugano',
  addressLocality: 'Lugano',
  canton: 'TI',
  contract: 'full-time',
  salaryMin: 60000,
  salaryMax: 75000,
  postedDate: new Date(Date.now() - 86400000 * 2).toISOString(),
  daysAgo: 2,
  slug: 'educatore-prima-infanzia-asilo-sole-lugano',
  slugByLocale: {},
  employmentType: 'full-time',
  url: 'https://example.com/job-1',
};

describe('professionLandingsPlugin uses canonical job cards', () => {
  it('emits canonical markers for the educatore landing', async () => {
    const mod = await import('../../build-plugins/professionLandingsPlugin');
    // The plugin exports a `renderFeaturedJobs` helper (or similar). If it's
    // not exported, export it for testability.
    const { renderFeaturedJobsForTest } = mod as any;
    expect(typeof renderFeaturedJobsForTest).toBe('function');
    const html = renderFeaturedJobsForTest('educatore', 'it', {
      featured: [FIXTURE_JOB],
      liveCount: 47,
      fresh30Count: 12,
      medianSalaryChf: 65000,
      topEmployers: [],
    });
    for (const m of CANONICAL_MARKERS) {
      expect(html, `missing canonical marker ${m}`).toMatch(m);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/build-plugins/job-card-canonical-adoption.test.ts`
Expected: FAIL — either `renderFeaturedJobsForTest` is undefined OR the existing inline renderer doesn't produce the canonical markers.

- [ ] **Step 3: Migrate the plugin**

Open `build-plugins/professionLandingsPlugin.ts`. Add imports at the top:

```typescript
import {
  renderJobCardListHtml,
  type JobCardJob,
} from './shared/jobCardHtml';
import {
  pickEmptyState,
  pickCtaAllJobs,
} from './shared/landingMicroCopy';
```

Delete the body of `renderFeaturedJobCard` (lines 166-188). Replace `renderFeaturedJobs` (lines 190-210) with:

```typescript
function renderFeaturedJobs(
  id: ProfessionId,
  locale: ProfessionLocale,
  snapshot: ProfessionJobsSnapshot,
  copy: CopyView,
): string {
  const items = snapshot.featured.map((j) => ({
    job: {
      title: j.title,
      titleByLocale: j.titleByLocale,
      company: j.company,
      companyKey: j.companyKey ?? undefined,
      companyDomain: j.companyDomain ?? undefined,
      addressLocality: j.addressLocality ?? j.city,
      canton: j.canton ?? undefined,
      contract: j.contract ?? undefined,
      salaryMin: j.salaryMin,
      salaryMax: j.salaryMax,
      postedDate: j.postedDate,
      url: j.url ?? undefined,
    } satisfies JobCardJob,
    href: buildFeaturedJobUrl(j, locale),
  }));
  const emptyHtml = `<p class="text-sm text-subtle">${escHtml(pickEmptyState(id, locale))}</p>`;
  const listHtml = renderJobCardListHtml(items, {
    locale,
    emptyStateHtml: emptyHtml,
  });
  const ctaHref = buildJobBoardUrl(locale);
  const ctaLabel = snapshot.liveCount > 0
    ? pickCtaAllJobs(id, locale, snapshot.liveCount)
    : copy.featuredJobsCtaAllLabel;
  return `<section style="margin:0 0 28px">
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${escHtml(copy.featuredJobsTitle)}</h2>
    ${listHtml}
    <a href="${escHtml(ctaHref)}" style="${LINK_ACCENT_STYLE};font-weight:700;font-size:15px;margin-top:14px;display:inline-block">${escHtml(ctaLabel)}</a>
  </section>`;
}

// Test-only export so the canonical-adoption test can call into the renderer.
export function renderFeaturedJobsForTest(
  id: ProfessionId,
  locale: ProfessionLocale,
  snapshot: ProfessionJobsSnapshot,
): string {
  return renderFeaturedJobs(id, locale, snapshot, getCopyView(locale));
}
```

The call site that previously called `renderFeaturedJobs(locale, snapshot, copy)` (search for it — likely once in the main render function) needs to pass `id` as the first arg. Update that call.

The `escHtml` helper — if the file already has its own `esc()` helper, reuse it; otherwise add the same `escHtml` body used in `employerCardHtml.ts`.

- [ ] **Step 4: Run the canonical-adoption test**

Run: `npx vitest run tests/build-plugins/job-card-canonical-adoption.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full vitest suite to catch regressions**

Run: `npx vitest run`
Expected: ALL PASS. If `tests/profession-landings-*.test.*` snapshot tests fail because the HTML output changed, that's expected — open them, verify the new output is the canonical job card, then update the snapshot with `npx vitest run -u tests/profession-landings-*`.

- [ ] **Step 6: Commit**

```bash
git add build-plugins/professionLandingsPlugin.ts tests/build-plugins/job-card-canonical-adoption.test.ts tests/
git commit -m "feat(seo): migrate profession landings to canonical job card"
```

---

### Task 7: Migrate `careerLandingsPlugin.ts` job cards to canonical

**Files:**
- Modify: `build-plugins/careerLandingsPlugin.ts` (lines 226-275)
- Modify: `tests/build-plugins/job-card-canonical-adoption.test.ts` (add a `describe` block)

- [ ] **Step 1: Read the existing renderer**

Run: `sed -n '220,280p' build-plugins/careerLandingsPlugin.ts`

- [ ] **Step 2: Extend the canonical-adoption test**

Append to `tests/build-plugins/job-card-canonical-adoption.test.ts`:

```typescript
describe('careerLandingsPlugin uses canonical job cards', () => {
  it('emits canonical markers', async () => {
    const mod = await import('../../build-plugins/careerLandingsPlugin');
    const { renderCareerFeaturedJobsForTest } = mod as any;
    expect(typeof renderCareerFeaturedJobsForTest).toBe('function');
    const html = renderCareerFeaturedJobsForTest(/* careerId */ Object.keys((mod as any).CAREER_IDS ?? {})[0] ?? 'cuoco', 'it', {
      featured: [FIXTURE_JOB],
      liveCount: 12,
      fresh30Count: 3,
      medianSalaryChf: 55000,
      topEmployers: [],
    });
    for (const m of CANONICAL_MARKERS) {
      expect(html, `missing canonical marker ${m}`).toMatch(m);
    }
  });
});
```

(If `CAREER_IDS` isn't an export, use any career id you find in `build-plugins/careerLandingsData.ts` and hardcode it.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/build-plugins/job-card-canonical-adoption.test.ts`
Expected: the career test fails.

- [ ] **Step 4: Migrate the plugin**

In `build-plugins/careerLandingsPlugin.ts`:

Add imports:

```typescript
import {
  renderJobCardListHtml,
  type JobCardJob,
} from './shared/jobCardHtml';
import {
  pickEmptyState,
  pickCtaAllJobs,
} from './shared/landingMicroCopy';
```

Delete the body of `renderFeaturedJobCard` (~line 226-248). Rewrite `renderFeaturedJobs` (~line 250-275) with the same pattern as Task 6 step 3, adapted to careerLandings' types. Add `renderCareerFeaturedJobsForTest` export at the bottom of the helper section.

- [ ] **Step 5: Run test + full suite**

Run: `npx vitest run tests/build-plugins/job-card-canonical-adoption.test.ts && npx vitest run`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add build-plugins/careerLandingsPlugin.ts tests/
git commit -m "feat(seo): migrate career landings to canonical job card"
```

---

### Task 8: Migrate `nursingLandingsPlugin.ts` job cards to canonical

**Files:**
- Modify: `build-plugins/nursingLandingsPlugin.ts` (lines 222-258)
- Modify: `tests/build-plugins/job-card-canonical-adoption.test.ts` (add a `describe` block)

- [ ] **Step 1: Extend the test**

Append to `tests/build-plugins/job-card-canonical-adoption.test.ts`:

```typescript
describe('nursingLandingsPlugin uses canonical job cards', () => {
  it('emits canonical markers', async () => {
    const mod = await import('../../build-plugins/nursingLandingsPlugin');
    const { renderNursingFeaturedJobsForTest } = mod as any;
    expect(typeof renderNursingFeaturedJobsForTest).toBe('function');
    const html = renderNursingFeaturedJobsForTest('infermiere', 'it', {
      featured: [FIXTURE_JOB],
      liveCount: 30,
      fresh30Count: 10,
      medianSalaryChf: 78000,
      topEmployers: [],
    });
    for (const m of CANONICAL_MARKERS) {
      expect(html, `missing canonical marker ${m}`).toMatch(m);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/build-plugins/job-card-canonical-adoption.test.ts`
Expected: nursing test fails.

- [ ] **Step 3: Migrate the plugin**

Same pattern as Task 6, applied to `build-plugins/nursingLandingsPlugin.ts` `renderFeaturedJobCard` (~line 222) and `renderFeaturedJobs` (~line 246). Add `renderNursingFeaturedJobsForTest` export.

- [ ] **Step 4: Run test + full suite**

Run: `npx vitest run`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/nursingLandingsPlugin.ts tests/
git commit -m "feat(seo): migrate nursing landings to canonical job card"
```

---

### Task 9: Migrate `costOfLivingLandingsPlugin.ts` job cards to canonical

**Files:**
- Modify: `build-plugins/costOfLivingLandingsPlugin.ts` (lines 153-210)
- Modify: `tests/build-plugins/job-card-canonical-adoption.test.ts` (add a `describe` block)

- [ ] **Step 1: Extend the test**

Append:

```typescript
describe('costOfLivingLandingsPlugin uses canonical job cards', () => {
  it('emits canonical markers', async () => {
    const mod = await import('../../build-plugins/costOfLivingLandingsPlugin');
    const { renderCostOfLivingFeaturedJobsForTest } = mod as any;
    expect(typeof renderCostOfLivingFeaturedJobsForTest).toBe('function');
    // Pick any cost-of-living city id exported by costOfLivingLandingsData
    const cityId = 'lugano';
    const html = renderCostOfLivingFeaturedJobsForTest(cityId, 'it', {
      featured: [FIXTURE_JOB],
      liveCount: 25,
      fresh30Count: 5,
      medianSalaryChf: 60000,
      topEmployers: [],
    });
    for (const m of CANONICAL_MARKERS) {
      expect(html, `missing canonical marker ${m}`).toMatch(m);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/build-plugins/job-card-canonical-adoption.test.ts`
Expected: cost-of-living test fails.

- [ ] **Step 3: Migrate the plugin**

Same pattern, applied to `build-plugins/costOfLivingLandingsPlugin.ts` `renderFeaturedJobCard` (~line 153) and `renderFeaturedJobs` (~line 180). Add `renderCostOfLivingFeaturedJobsForTest` export.

- [ ] **Step 4: Run test + full suite**

Run: `npx vitest run`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/costOfLivingLandingsPlugin.ts tests/
git commit -m "feat(seo): migrate costOfLiving landings to canonical job card"
```

---

## Phase 4 — Migrate employer cards (5 plugins)

### Task 10: Migrate `professionLandingsPlugin.ts` employer grid

**Files:**
- Modify: `build-plugins/professionLandingsPlugin.ts` (lines 212-242 — `renderEmployerGrid`)

- [ ] **Step 1: Write the failing test**

Create `tests/build-plugins/employer-card-canonical-adoption.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

const CANONICAL_EMPLOYER_MARKERS = [
  /<ul[^>]+role="list"/,
  /bg-surface-raised/,
  /border-edge/,
];

describe('professionLandingsPlugin uses canonical employer cards', () => {
  it('renders ul role=list with canonical employer markup', async () => {
    const mod = await import('../../build-plugins/professionLandingsPlugin');
    const { renderEmployerGridForTest } = mod as any;
    expect(typeof renderEmployerGridForTest).toBe('function');
    const html = renderEmployerGridForTest('educatore', 'it', {
      topEmployers: [
        { name: 'Migros Ticino', count: 5 },
        { name: 'SUPSI', count: 3 },
      ],
    });
    for (const m of CANONICAL_EMPLOYER_MARKERS) {
      expect(html, `missing marker ${m}`).toMatch(m);
    }
    expect(html).toContain('Migros Ticino');
    expect(html).toContain('SUPSI');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/build-plugins/employer-card-canonical-adoption.test.ts`
Expected: FAIL — `renderEmployerGridForTest` undefined or markers absent.

- [ ] **Step 3: Migrate `renderEmployerGrid`**

In `build-plugins/professionLandingsPlugin.ts`, add imports:

```typescript
import {
  renderEmployerCardListHtml,
  type EmployerCardEmployer,
} from './shared/employerCardHtml';
```

Replace `renderEmployerGrid` body (lines 212-242) with:

```typescript
function renderEmployerGrid(
  snapshot: ProfessionJobsSnapshot,
  id: ProfessionId,
  copy: CopyView,
  locale: ProfessionLocale,
): string {
  const useAggregate = snapshot.topEmployers.length >= 3;
  const rows = useAggregate
    ? snapshot.topEmployers.map((e) => ({ name: e.name, count: e.count }))
    : PROFESSION_FACTS[id].topEmployers.slice(0, 6).map((n) => ({ name: n, count: null as number | null }));

  if (rows.length === 0) return '';

  const items = rows.map((r) => ({
    employer: {
      name: r.name,
      openings: r.count,
    } satisfies EmployerCardEmployer,
    href: buildEmployerHrefForProfession(r.name, id, locale),
  }));

  const listHtml = renderEmployerCardListHtml(items, {
    locale,
    variant: 'compact',
  });

  return `<section style="margin:0 0 28px">
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${escHtml(copy.employerGridTitle)}</h2>
    ${listHtml}
  </section>`;
}

// Test-only export.
export function renderEmployerGridForTest(
  id: ProfessionId,
  locale: ProfessionLocale,
  snapshot: Pick<ProfessionJobsSnapshot, 'topEmployers'>,
): string {
  return renderEmployerGrid(
    { ...snapshot, liveCount: 0, fresh30Count: 0, medianSalaryChf: null, featured: [] } as ProfessionJobsSnapshot,
    id,
    getCopyView(locale),
    locale,
  );
}

function buildEmployerHrefForProfession(
  name: string,
  id: ProfessionId,
  locale: ProfessionLocale,
): string {
  // Profession landings don't currently have per-employer pages — link to
  // the canton-aware employer landing if the slug exists, otherwise to the
  // job-board pre-filtered by company name.
  const employerSlug = slugifyCompanyName(name);
  return `${PROFESSION_LOCALE_PREFIX[locale]}aziende-ticino/${employerSlug}/`;
}
```

If `slugifyCompanyName` doesn't exist in the file, import it from `services/jobDataNormalization.ts` (it's the same helper used elsewhere — verify with `grep -r "export function slugifyCompanyName\|export function slugifyEmployer" services/ build-plugins/`).

The call site that previously called `renderEmployerGrid(snapshot, id, copyView)` needs the `locale` argument added.

- [ ] **Step 4: Run tests + type-check**

Run: `npx vitest run tests/build-plugins/employer-card-canonical-adoption.test.ts && npx tsc --noEmit`
Expected: PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/professionLandingsPlugin.ts tests/build-plugins/employer-card-canonical-adoption.test.ts
git commit -m "feat(seo): migrate profession landings to canonical employer card"
```

---

### Task 11: Migrate `careerLandingsPlugin.ts` employer grid

**Files:**
- Modify: `build-plugins/careerLandingsPlugin.ts` (lines 280-310 — `renderEmployerGrid`)
- Modify: `tests/build-plugins/employer-card-canonical-adoption.test.ts` (add describe block)

- [ ] **Step 1: Extend test**

Append:

```typescript
describe('careerLandingsPlugin uses canonical employer cards', () => {
  it('renders canonical employer markup', async () => {
    const mod = await import('../../build-plugins/careerLandingsPlugin');
    const { renderCareerEmployerGridForTest } = mod as any;
    expect(typeof renderCareerEmployerGridForTest).toBe('function');
    const html = renderCareerEmployerGridForTest('cuoco', 'it', {
      topEmployers: [{ name: 'Ristorante Da Mario', count: 2 }],
    });
    for (const m of CANONICAL_EMPLOYER_MARKERS) expect(html).toMatch(m);
    expect(html).toContain('Ristorante Da Mario');
  });
});
```

- [ ] **Step 2: Run test → fail**

Run: `npx vitest run tests/build-plugins/employer-card-canonical-adoption.test.ts`

- [ ] **Step 3: Migrate**

Same pattern as Task 10, applied to `careerLandingsPlugin.ts`. Add `renderCareerEmployerGridForTest` export.

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/careerLandingsPlugin.ts tests/
git commit -m "feat(seo): migrate career landings to canonical employer card"
```

---

### Task 12: Migrate `nursingLandingsPlugin.ts` employer grid

**Files:**
- Modify: `build-plugins/nursingLandingsPlugin.ts` (lines 266-300)
- Modify: `tests/build-plugins/employer-card-canonical-adoption.test.ts`

- [ ] **Step 1-5**: same pattern as Task 11, adapted to nursing. Test name: `renderNursingEmployerGridForTest`. Test id: `'infermiere'`. Test employer: `'Casa anziani San Giorgio'`.

Commit message: `feat(seo): migrate nursing landings to canonical employer card`

---

### Task 13: Migrate `costOfLivingLandingsPlugin.ts` employer grid

**Files:**
- Modify: `build-plugins/costOfLivingLandingsPlugin.ts` (lines 213-260)
- Modify: `tests/build-plugins/employer-card-canonical-adoption.test.ts`

- [ ] **Step 1-5**: same pattern. Test name: `renderCostOfLivingEmployerGridForTest`. Test id: `'lugano'`. Test employer: `'Lugano Welcome'`.

Commit message: `feat(seo): migrate costOfLiving landings to canonical employer card`

---

### Task 14: Migrate `weeklyEmployersPlugin.ts` company cards to detailed variant

**Files:**
- Modify: `build-plugins/weeklyEmployersPlugin.ts` (the company-card render section — search for `logoUrl` near line 2669)
- Modify: `tests/build-plugins/employer-card-canonical-adoption.test.ts`

- [ ] **Step 1: Identify the company-card render block**

Run: `grep -nE "logoUrl|companyCard|renderCompany" build-plugins/weeklyEmployersPlugin.ts | head -20`

The plugin currently builds an `entries` array with `{ name, logoUrl, logoAlt, iconSvg, ... }` and emits cards inline. Migrate to the shared `renderEmployerCardListHtml` with `variant: 'detailed'`.

- [ ] **Step 2: Extend the canonical-adoption test**

Append:

```typescript
describe('weeklyEmployersPlugin uses canonical employer cards (detailed)', () => {
  it('renders detailed-variant employer markup', async () => {
    const mod = await import('../../build-plugins/weeklyEmployersPlugin');
    const { renderWeeklyEmployerSectionForTest } = mod as any;
    expect(typeof renderWeeklyEmployerSectionForTest).toBe('function');
    const html = renderWeeklyEmployerSectionForTest('it', [
      {
        employer: 'Lonza',
        employerKey: 'lonza',
        city: 'Visp',
        sector: 'Farmaceutica',
        openings: 35,
      },
    ]);
    expect(html).toMatch(/<article class="rounded-xl border border-edge/);
    expect(html).toContain('Lonza');
    expect(html).toContain('Visp');
    expect(html).toContain('Farmaceutica');
  });
});
```

- [ ] **Step 3: Run test → fail**

Run: `npx vitest run tests/build-plugins/employer-card-canonical-adoption.test.ts`

- [ ] **Step 4: Migrate the plugin**

Add imports at the top of `weeklyEmployersPlugin.ts`:

```typescript
import {
  renderEmployerCardListHtml,
  type EmployerCardEmployer,
} from './shared/employerCardHtml';
```

Find the block where the current employer cards are emitted (search `<article` or `class="employer-card"` or wherever the cards are constructed — likely around line 2660-2700 based on the earlier grep). Replace it with a call to `renderEmployerCardListHtml` using `variant: 'detailed'`. Preserve the per-employer `href` builder already used by the plugin.

Add a `renderWeeklyEmployerSectionForTest(locale, employers)` export that wraps the migrated render path for the test.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS. If weekly-employers snapshot tests fail, update them.

- [ ] **Step 6: Commit**

```bash
git add build-plugins/weeklyEmployersPlugin.ts tests/
git commit -m "feat(seo): migrate weeklyEmployers to canonical employer card (detailed)"
```

---

## Phase 5 — Stylistic refresh

### Task 15: Add fade-in CSS animation

**Files:**
- Modify: `index.css` (add at the end of the file)

- [ ] **Step 1: Locate end of index.css**

Run: `wc -l index.css && tail -20 index.css`

- [ ] **Step 2: Append the keyframes + class**

Append to `index.css`:

```css
@keyframes seo-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.seo-fade-in {
  animation: seo-fade-in 320ms ease-out both;
}
@media (prefers-reduced-motion: reduce) {
  .seo-fade-in { animation: none; }
}
```

- [ ] **Step 3: Commit**

```bash
git add index.css
git commit -m "feat(css): add seo-fade-in utility (respects prefers-reduced-motion)"
```

---

### Task 16: Refresh hero + stats tiles + micro-copy in `professionLandingsPlugin.ts`

**Files:**
- Modify: `build-plugins/professionLandingsPlugin.ts` (the main page render function — search for `<h1` or `renderProfessionLandingPage`)

- [ ] **Step 1: Locate the current hero rendering**

Run: `grep -nE "<h1|<header|renderProfession.*Page|renderPage" build-plugins/professionLandingsPlugin.ts | head -10`

Identify where the page assembles its HTML between the breadcrumb and the featured jobs section.

- [ ] **Step 2: Add imports**

```typescript
import {
  renderLandingHero,
  type HeroVars,
} from './shared/landingHeroPersonality';
import {
  STAT_TILE_ACCENT,
  STAT_TILE_SUCCESS,
  STAT_TILE_WARNING,
  STAT_TILE_BASE,
  STAT_TILE_LABEL,
  STAT_TILE_VALUE,
} from './shared/seoContentTokens';
```

- [ ] **Step 3: Replace hero block**

Find the current `<header>` / `<h1>` block in the page render function. Replace with:

```typescript
const heroVars: HeroVars = {
  openings: snapshot.liveCount,
  medianSalary: snapshot.medianSalaryChf ?? undefined,
};
const heroHtml = renderLandingHero(id, locale, heroVars, h1Text);
```

Where `h1Text` is the existing computed H1 string. Insert `heroHtml` where `<h1>` used to be.

- [ ] **Step 4: Add stats tile grid right after the hero**

Insert immediately after `heroHtml`:

```typescript
const openingsTileStyle = snapshot.liveCount > 20
  ? STAT_TILE_SUCCESS
  : snapshot.liveCount >= 5
    ? STAT_TILE_WARNING
    : STAT_TILE_BASE;

const tiles: string[] = [];
tiles.push(
  `<div class="seo-fade-in" style="${openingsTileStyle}">
    <div style="${STAT_TILE_LABEL}">${escHtml(copy.statOpeningsLabel)}</div>
    <div style="${STAT_TILE_VALUE}">${snapshot.liveCount}</div>
  </div>`,
);
if (snapshot.medianSalaryChf) {
  tiles.push(
    `<div class="seo-fade-in" style="${STAT_TILE_ACCENT}">
      <div style="${STAT_TILE_LABEL}">${escHtml(copy.statMedianSalaryLabel)}</div>
      <div style="${STAT_TILE_VALUE}">CHF ${Math.round(snapshot.medianSalaryChf / 1000)}k</div>
    </div>`,
  );
}
if (snapshot.fresh30Count > 0) {
  tiles.push(
    `<div class="seo-fade-in" style="${STAT_TILE_SUCCESS}">
      <div style="${STAT_TILE_LABEL}">${escHtml(copy.statFresh30Label)}</div>
      <div style="${STAT_TILE_VALUE}">${snapshot.fresh30Count}</div>
    </div>`,
  );
}
if (snapshot.topEmployers.length > 0) {
  tiles.push(
    `<div class="seo-fade-in" style="${STAT_TILE_BASE}">
      <div style="${STAT_TILE_LABEL}">${escHtml(copy.statEmployersLabel)}</div>
      <div style="${STAT_TILE_VALUE}">${snapshot.topEmployers.length}</div>
    </div>`,
  );
}

const tilesHtml = tiles.length >= 2
  ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:16px 0 24px">${tiles.join('')}</div>`
  : '';
```

The `copy.statOpeningsLabel`, `copy.statMedianSalaryLabel`, `copy.statFresh30Label`, `copy.statEmployersLabel` need to exist in `professionLandingsCopy.ts` — open it and add them with translations for all 4 locales:

```typescript
statOpeningsLabel: { it: 'Posti aperti', en: 'Open positions', de: 'Offene Stellen', fr: 'Postes ouverts' },
statMedianSalaryLabel: { it: 'Stipendio mediano', en: 'Median salary', de: 'Median-Gehalt', fr: 'Salaire médian' },
statFresh30Label: { it: 'Nuovi (ultimi 30g)', en: 'Fresh (last 30d)', de: 'Neu (30 Tage)', fr: 'Récents (30j)' },
statEmployersLabel: { it: 'Aziende', en: 'Employers', de: 'Arbeitgeber', fr: 'Employeurs' },
```

(Names must match the existing copy access pattern in the file — check how other labels are organised.)

- [ ] **Step 5: Insert in page output**

Where the page HTML is assembled (the big template literal that combines breadcrumb + header + featured jobs + employer grid + prose), replace the old header block with `${heroHtml}${tilesHtml}`.

- [ ] **Step 6: Run vitest, fix any snapshot drift**

Run: `npx vitest run`
Expected: PASS, except possibly snapshot tests for profession-landings HTML which now contain the new hero + tiles — open them, eyeball-verify the new output, update with `npx vitest run -u tests/profession-landings-*`.

- [ ] **Step 7: Smoke render**

Run:

```bash
npx tsx -e "
import('./build-plugins/professionLandingsPlugin.js').then(m => {
  // If the plugin exports a render-for-test, call it. Otherwise skip.
  console.log('plugin loaded OK');
}).catch(e => { console.error(e); process.exit(1); });
"
```

Or better — write a tiny smoke script `scripts/smoke-render-profession.mjs` that calls the plugin's render path for `id=educatore, locale=it` and writes to `/tmp/educatore-preview.html`. Then:

```bash
grep -c "🎓" /tmp/educatore-preview.html              # should be ≥1 (eyebrow emoji)
grep -c "w-10 h-10 sm:w-14 sm:h-14" /tmp/educatore-preview.html  # should be ≥1 per job card
grep -c "seo-fade-in" /tmp/educatore-preview.html      # should be ≥2 (stats tiles)
grep -c "var(--color-success-subtle)" /tmp/educatore-preview.html  # tiles bind to tokens
```

- [ ] **Step 8: Commit**

```bash
git add build-plugins/professionLandingsPlugin.ts build-plugins/professionLandingsCopy.ts tests/
git commit -m "feat(seo): refresh profession landings hero + stats tiles + micro-copy"
```

---

### Task 17: Apply same stylistic refresh to `careerLandingsPlugin.ts`

**Files:**
- Modify: `build-plugins/careerLandingsPlugin.ts`
- Modify: `build-plugins/careerLandingsCopy.ts` (add the 4 stat labels)

- [ ] **Step 1-8**: Mirror Task 16 step-by-step. Same imports, same tile logic, same fade-in class, same copy keys. Verify the career copy file accepts the new keys. Smoke render with `id=cuoco`.

Commit: `feat(seo): refresh career landings hero + stats tiles`

---

### Task 18: Apply same stylistic refresh to `nursingLandingsPlugin.ts`

**Files:**
- Modify: `build-plugins/nursingLandingsPlugin.ts`
- Modify: `build-plugins/nursingLandingsCopy.ts`

- [ ] **Step 1-8**: Mirror Task 16. Smoke render with `id=infermiere`.

Commit: `feat(seo): refresh nursing landings hero + stats tiles`

---

### Task 19: Apply same stylistic refresh to `costOfLivingLandingsPlugin.ts`

**Files:**
- Modify: `build-plugins/costOfLivingLandingsPlugin.ts`
- Modify: `build-plugins/costOfLivingLandingsCopy.ts`

- [ ] **Step 1-8**: Mirror Task 16. **Note:** costOfLiving ids are city names — populate `HERO_BADGES` entries for the top cost-of-living cities (lugano, locarno, mendrisio, bellinzona, chiasso, zurigo, ginevra, basilea — check `costOfLivingLandingsData.ts` for the actual list) BEFORE this task, or rely on the `fallbackTagline` parameter in `renderLandingHero` for unmapped ids. Pragmatic call: in this task, EXTEND `HERO_BADGES` with the city ids using emoji `🏠` and city-appropriate tagline:

```typescript
// Add to landingHeroPersonality.ts HERO_BADGES
lugano: {
  emoji: '🏙️',
  eyebrowLabel: {
    it: 'Costo della vita · Lugano',
    en: 'Cost of living · Lugano',
    de: 'Lebenshaltung · Lugano',
    fr: 'Coût de la vie · Lugano',
  },
  taglineTemplate: {
    it: (v) => `Affitti, spesa, salari netti: ${v.openings} lavori aperti${v.medianSalary ? `, ${chf(v.medianSalary)} mediana` : ''}.`,
    // ... en/de/fr same pattern
  },
},
// ... 1 entry per city in COST_OF_LIVING_CITY_IDS
```

If you go this route, FIRST update `tests/build-plugins/landing-hero-personality.test.ts` to include the city ids in the coverage check.

Smoke render with `id=lugano`.

Commit: `feat(seo): refresh costOfLiving landings hero + stats tiles`

---

## Phase 6 — CI wiring + final verification

### Task 20: Wire vitest into `deploy.yml`

**Why:** Memory `feedback_regression_gates_need_ci_runner.md` — adding vitest regression tests without CI wiring = fake gate. PR #294 / #319 incident proves it.

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Confirm the gap**

Run: `grep -nE "vitest|npm test|npm run test:" .github/workflows/deploy.yml`
Expected: 0 matches.

- [ ] **Step 2: Add a vitest step before the Build step**

Open `.github/workflows/deploy.yml`. Find the `- name: Build` step (line ~355). Insert IMMEDIATELY BEFORE it:

```yaml
      - name: Vitest unit + build-plugin tests
        run: npx vitest run --reporter=default
        env:
          NODE_OPTIONS: --max-old-space-size=8192
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci(deploy): run vitest before build (closes fake-gate hole)"
```

---

### Task 21: Final pre-push verification

- [ ] **Step 1: Run prepush:fast**

Run: `npm run prepush:fast`
Expected: type-check passes, vitest passes, FAST_BUILD vite build passes (incremental local build, won't OOM).

If anything fails, fix it and re-run. Do not push with red tests.

- [ ] **Step 2: GitNexus impact check**

Run impact analysis on the 4 deleted `renderFeaturedJobCard` and 4 modified `renderEmployerGrid`:

```
gitnexus_impact({target: "renderFeaturedJobCard", direction: "upstream"})
gitnexus_impact({target: "renderEmployerGrid", direction: "upstream"})
```

Expected: blast radius limited to the 4 plugin files (internal callers only). If any external caller surfaces, address it before pushing.

- [ ] **Step 3: Detect changes scope**

```
gitnexus_detect_changes({scope: "all"})
```

Expected scope:
- 4 new shared modules
- 4 modified aggregates
- 5 modified plugins (4 landings + weeklyEmployers)
- 4 modified copy files
- index.css
- deploy.yml
- 5 new test files

If files outside this set appear, investigate before pushing.

---

### Task 22: Push + open PR + merge + cleanup

- [ ] **Step 1: Push branch**

Run: `git push -u origin refactor/canonical-cards-and-landing-refresh`

If `git push` SIGKILLs in a long session (memory `feedback_push_via_rest_api_fallback.md`), fall back to `gh api git/blobs+trees+commits+refs`.

- [ ] **Step 2: Create + squash-merge PR (no review ceremony)**

Run:

```bash
PR_URL=$(gh pr create --fill)
PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
gh pr merge "$PR_NUM" --squash
```

- [ ] **Step 3: Delete remote branch explicitly**

```bash
git push origin --delete refactor/canonical-cards-and-landing-refresh
```

(`gh pr merge --delete-branch` fails silently when worktree blocks local cleanup — memory `feedback_cleanup_remote_branch_after_squash_merge.md`.)

- [ ] **Step 4: Exit worktree**

Use `ExitWorktree` tool with `action: remove, discard_changes: true` (commit is already on main).

---

### Task 23: Post-deploy verification

- [ ] **Step 1: Watch the deploy workflow**

Run: `gh run watch $(gh run list --workflow=deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')`
Expected: conclusion `success`.

- [ ] **Step 2: Live curl + grep on 6 sample pages**

```bash
for url in \
  "https://frontaliereticino.ch/lavoro-ticino-educatore/" \
  "https://frontaliereticino.ch/lavoro-ticino-infermiere/" \
  "https://frontaliereticino.ch/lavoro-ticino-cuoco/" \
  ; do
  echo "=== $url ==="
  html=$(curl -sL "$url")
  echo "$html" | grep -oE "w-10 h-10 sm:w-14 sm:h-14 rounded-lg" | head -1
  echo "$html" | grep -oE "Logo [A-Z][^\"]{0,30}" | head -1
  echo "$html" | grep -oE "🎓|🩺|⚙️|💼|📐|🚛|🏗️|🍳|🍽️|🔌" | head -1
  echo "$html" | grep -oE "seo-fade-in" | head -1
done
```

Expected for each: all 4 grep lines return non-empty.

- [ ] **Step 3: Pick one career, one nursing, one costOfLiving, one weekly-employers page**

Repeat the same grep pattern on:
- A career landing (find via `grep -E "buildCareerLandingPath" build-plugins/careerLandingsData.ts`)
- A nursing landing
- A cost-of-living city page
- A weekly-employers city page (e.g., `/weekly-employers/lugano/`)

- [ ] **Step 4: Re-index GitNexus**

Run: `npx gitnexus analyze --embeddings` (if embeddings were present — check `.gitnexus/meta.json` `stats.embeddings`).

The PostToolUse hook may already handle this for commits/merges — verify with: `cat .gitnexus/meta.json | python3 -c "import json,sys; print(json.load(sys.stdin)['indexed_at'])"` should be recent.

- [ ] **Step 5: Report success to user**

Summary message:
- Migrated N plugins to canonical job + employer cards.
- Hero/tiles/micro-copy refresh shipped on 4 landing types.
- 5 new vitest gates active in CI.
- Live verification: ✅ on 6+ sample pages.

---

## Self-Review

**Spec coverage check** (cross-referenced against `docs/superpowers/specs/2026-05-19-valerielinc-canonical-cards-and-landing-refresh-design.md`):

- Spec §"New shared modules" → Tasks 1-4 (companyLogoResolver, employerCardHtml, landingHeroPersonality, landingMicroCopy) ✅
- Spec §"Snapshot enrichment" → Task 5 ✅
- Spec §"Job-card migration" → Tasks 6-9 (4 plugins) ✅
- Spec §"Employer-card migration" → Tasks 10-14 (5 plugins incl. weeklyEmployers detailed) ✅
- Spec §"Hero personality" → Tasks 16-19 (4 plugins) ✅
- Spec §"Stats tiles colorate" → Tasks 16-19 ✅
- Spec §"Micro-copy" → Tasks 16-19 (uses the helpers from Task 4) ✅
- Spec §"Animazione fade-in" → Task 15 + applied in Tasks 16-19 ✅
- Spec §"CI wiring" → Task 20 ✅
- Spec §"Manual verification (post-merge)" → Task 23 ✅
- Spec §"Risks" → Pre-flight Task 0 verifies clean tree (worktree merge conflict risk); Task 21 runs gitnexus_impact (blast radius risk); Task 23 verifies live (deploy regression risk) ✅

**Placeholder scan:** I scanned the plan; the only "Same pattern as Task N" references appear in Tasks 17-19 and 12-13. They are accompanied by the explicit Task 16/Task 11 reference plus the test name/id/employer override, so an engineer reading them out of order has the concrete diffs. The "Step 1-8: Mirror Task N" pattern is acceptable because the upstream task contains the full code blocks.

**Type consistency check:**
- `EmployerCardEmployer` properties (`name`, `companyKey`, `companyDomain`, `openings`, `city`, `sector`) — consistent across Tasks 2, 10-14.
- `JobCardJob` properties used in Tasks 6-9 — match the canonical interface in `build-plugins/shared/jobCardHtml.ts`.
- `HeroVars` (`openings`, `medianSalary`, `city`) — consistent across Tasks 3, 16-19.
- `STAT_TILE_*` constants — names match `build-plugins/shared/seoContentTokens.ts` actual exports (verified in pre-plan exploration).
- `renderFeaturedJobsForTest` / `renderCareerFeaturedJobsForTest` / etc — naming convention is consistent (camelCase + plugin name + ForTest).

No gaps found.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-05-19-canonical-cards-and-landing-refresh.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a 22-task plan where many tasks (10-13, 17-19) are pattern-repeats and benefit from clean context per execution.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Risks context bloat over 22 tasks.

Which approach?
