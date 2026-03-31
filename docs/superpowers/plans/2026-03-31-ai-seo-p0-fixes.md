# AI SEO P0 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 3 highest-impact AI SEO fixes: visible "last updated" dates on all static pages, honest expert author schema, and datePublished/dateModified on Dataset schemas. Also batch in HowTo totalTime and Article image fixes.

**Architecture:** All changes are in the build pipeline (staticPagesPlugin, seo-pages.ts, seoService.ts). No React component changes needed. The visible date line is injected into static HTML at build time. Schema fixes are property additions to existing structured data objects.

**Tech Stack:** TypeScript, Vite build plugins, Schema.org JSON-LD

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `build-plugins/staticPagesPlugin.ts` | Modify | Inject visible "Ultimo aggiornamento" date line into static HTML |
| `services/seoService.ts` | Modify | Fix SCHEMA_EXPERT_AUTHOR from fake Person to Organization |
| `services/seo/seo-pages.ts` | Modify | Add datePublished/dateModified to Datasets, totalTime to HowTos, image to Articles |
| `build-plugins/ogPagesPlugin.ts` | Modify | Use SCHEMA_AUTHOR (Organization) instead of SCHEMA_EXPERT_AUTHOR |
| `tests/ai-seo-p0.test.ts` | Create | Tests for all 5 changes |

---

### Task 1: Visible "Last Updated" date on all static pages

The `staticPagesPlugin.ts` generates ~2400 static HTML pages. None show a visible update date. AI systems weight freshness heavily. This adds a visible date line below the page description on every static page.

**Files:**
- Modify: `build-plugins/staticPagesPlugin.ts:1386` (editorialHtml construction)
- Test: `tests/ai-seo-p0.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/ai-seo-p0.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('AI SEO P0: Visible last-updated dates', () => {
  const distDir = path.resolve(__dirname, '..', 'dist');

  // Sample pages across different sections
  const samplePages = [
    'calcola-stipendio/simula-busta-paga/index.html',
    'compara-servizi/cambio-franco-euro/index.html',
    'tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026/index.html',
    'guida-frontaliere/permessi-di-lavoro/index.html',
    'statistiche/confronta-stipendi/index.html',
    'en/calculate-salary/simulate-payslip/index.html',
  ];

  for (const page of samplePages) {
    it(`${page} has a visible last-updated date`, () => {
      const filePath = path.join(distDir, page);
      if (!fs.existsSync(filePath)) return; // skip if page not in build
      const html = fs.readFileSync(filePath, 'utf-8');
      // Check for localized "last updated" text pattern
      expect(html).toMatch(/Ultimo aggiornamento|Last updated|Letzte Aktualisierung|Dernière mise à jour/);
      // Check it contains a date-like pattern (month year or YYYY-MM)
      expect(html).toMatch(/202[5-9]/);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai-seo-p0.test.ts`
Expected: FAIL — no "Ultimo aggiornamento" text in static HTML pages

- [ ] **Step 3: Implement visible date injection in staticPagesPlugin.ts**

In `build-plugins/staticPagesPlugin.ts`, find the `editorialHtml` construction (around line 1386). Add a date line before the editorial blocks.

Find:
```typescript
const editorialHtml = `<div style="margin-top:.75rem;font-size:.95rem;line-height:1.6;color:#334155">${editorialBlocks.map((b) => `<p style="margin:.5rem 0">${esc(b)}</p>`).join('')}${faqHtml}${relatedHtml}</div>`;
```

Replace with:
```typescript
const LAST_UPDATED_LABEL: Record<string, string> = {
  it: 'Ultimo aggiornamento',
  en: 'Last updated',
  de: 'Letzte Aktualisierung',
  fr: 'Dernière mise à jour',
};
const dateLabel = LAST_UPDATED_LABEL[locale] ?? LAST_UPDATED_LABEL.it;
const dateFormatLocale = locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : 'en-GB';
const formattedDate = new Date().toLocaleDateString(dateFormatLocale, { month: 'long', year: 'numeric' });
const dateLine = `<p style="margin:.5rem 0;font-size:.8rem;color:#94a3b8"><time datetime="${new Date().toISOString().slice(0, 10)}">${dateLabel}: ${formattedDate}</time></p>`;
const editorialHtml = `<div style="margin-top:.75rem;font-size:.95rem;line-height:1.6;color:#334155">${dateLine}${editorialBlocks.map((b) => `<p style="margin:.5rem 0">${esc(b)}</p>`).join('')}${faqHtml}${relatedHtml}</div>`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai-seo-p0.test.ts`
Expected: PASS

- [ ] **Step 5: Verify build succeeds**

Run: `npx vite build 2>&1 | tail -5`
Expected: Build completes successfully

- [ ] **Step 6: Spot-check a rendered page**

Run: `grep -m1 "Ultimo aggiornamento" dist/calcola-stipendio/simula-busta-paga/index.html`
Expected: Shows the date line with current month/year

- [ ] **Step 7: Commit**

```bash
git add build-plugins/staticPagesPlugin.ts tests/ai-seo-p0.test.ts
git commit -m "feat: add visible 'last updated' date to all static pages for AI SEO freshness signals"
```

---

### Task 2: Fix expert author schema (Person -> Organization)

`SCHEMA_EXPERT_AUTHOR` in `seoService.ts:78` declares `@type: Person` with `name: "Frontaliere Ticino"` — this is detectable as a fake person (the brand name is not a real human). AI systems give +25% boost for real experts but can penalize fake attribution. Since the site has no named human author, the honest approach is to use Organization author with strong E-E-A-T signals.

**Files:**
- Modify: `services/seoService.ts:78-84`
- Modify: `build-plugins/ogPagesPlugin.ts` (any reference to SCHEMA_EXPERT_AUTHOR)
- Test: `tests/ai-seo-p0.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/ai-seo-p0.test.ts`:

```typescript
describe('AI SEO P0: Honest author schema', () => {
  it('SCHEMA_EXPERT_AUTHOR should not be @type Person with a brand name', async () => {
    const seoModule = await import('../services/seoService');
    const author = seoModule.SCHEMA_EXPERT_AUTHOR;
    // Should NOT be a Person with a brand name
    if ('@type' in author && author['@type'] === 'Person') {
      // If it's a Person, the name must not be "Frontaliere Ticino" (brand name)
      expect(author.name).not.toBe('Frontaliere Ticino');
    }
  });

  it('Blog article pages should use Organization or real Person author', () => {
    const distDir = path.resolve(__dirname, '..', 'dist');
    const sampleArticle = 'articoli-frontaliere/a13-cantieri-frontalieri-ticino/index.html';
    const filePath = path.join(distDir, sampleArticle);
    if (!fs.existsSync(filePath)) return;
    const html = fs.readFileSync(filePath, 'utf-8');
    // Extract all JSON-LD blocks
    const jsonLdBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
      .filter(Boolean);
    const articleSchema = jsonLdBlocks.find(s =>
      s['@type'] === 'NewsArticle' || s['@type'] === 'Article' || s['@type'] === 'BlogPosting'
    );
    if (!articleSchema?.author) return;
    // Author should be Organization ref or real Person, not fake Person
    if (articleSchema.author['@type'] === 'Person') {
      expect(articleSchema.author.name).not.toBe('Frontaliere Ticino');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai-seo-p0.test.ts`
Expected: FAIL — SCHEMA_EXPERT_AUTHOR is Person with name "Frontaliere Ticino"

- [ ] **Step 3: Change SCHEMA_EXPERT_AUTHOR to Organization**

In `services/seoService.ts`, find lines 73-84 and replace:

```typescript
/**
 * Expert Person author for blog articles — AI systems give +25% citation
 * boost for named expert authors vs anonymous Organization authors.
 * Used in BlogPosting/NewsArticle structured data.
 */
export const SCHEMA_EXPERT_AUTHOR = {
  "@type": "Person",
  "name": "Frontaliere Ticino",
  "jobTitle": "Esperto fiscale frontalieri",
  "url": `${BASE_URL}/chi-siamo`,
  "worksFor": { "@id": `${BASE_URL}/#organization` },
} as const;
```

With:

```typescript
/**
 * Organization author for blog articles and editorial content.
 * Uses @id reference to the standalone Organization in index.html
 * for knowledge graph consistency. AI systems recognize Organization
 * authors with strong E-E-A-T signals (knowsAbout, areaServed)
 * from the referenced Organization entity.
 */
export const SCHEMA_EXPERT_AUTHOR = {
  "@id": `${BASE_URL}/#organization`,
} as const;
```

This is the same pattern as `SCHEMA_AUTHOR` and `SCHEMA_PUBLISHER` — a reference to the full Organization entity in index.html which already has `knowsAbout`, `areaServed`, `sameAs`, etc.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai-seo-p0.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (no regressions from author change)

- [ ] **Step 6: Commit**

```bash
git add services/seoService.ts tests/ai-seo-p0.test.ts
git commit -m "fix: replace fake Person author with Organization @id reference for honest E-E-A-T"
```

---

### Task 3: Add datePublished/dateModified to Dataset schemas

All 8+ Dataset schemas in `seo-pages.ts` lack `datePublished` and `dateModified`. Google Dataset Search penalizes undated datasets.

**Files:**
- Modify: `services/seo/seo-pages.ts` (all Dataset entries)
- Test: `tests/ai-seo-p0.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/ai-seo-p0.test.ts`:

```typescript
describe('AI SEO P0: Dataset date fields', () => {
  it('all Dataset schemas should have dateModified', async () => {
    const mod = await import('../services/seo/seo-pages.ts');
    // The module default-exports or named-exports SEO_PAGES_METADATA
    // Access it via the module's shape
    const metadata = (mod as Record<string, unknown>).default ?? Object.values(mod).find(v => typeof v === 'object' && v !== null && !Array.isArray(v));
    if (!metadata || typeof metadata !== 'object') return;

    for (const [key, entry] of Object.entries(metadata as Record<string, { structuredData?: Record<string, unknown> | Record<string, unknown>[] }>)) {
      const sd = entry.structuredData;
      if (!sd) continue;
      const schemas = Array.isArray(sd) ? sd : [sd];
      for (const schema of schemas) {
        if (schema['@type'] === 'Dataset') {
          expect(schema, `Dataset in "${key}" missing dateModified`).toHaveProperty('dateModified');
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai-seo-p0.test.ts`
Expected: FAIL — Dataset schemas lack dateModified

- [ ] **Step 3: Add dateModified to all Dataset schemas**

In `services/seo/seo-pages.ts`, find each `"@type": "Dataset"` block and add `"dateModified": BUILD_DATE_ISO` to it. There are approximately 8-10 Dataset entries across the file. Each one needs:

```typescript
"dateModified": BUILD_DATE_ISO,
```

Search for `"@type": "Dataset"` and add the property inside each object. The `BUILD_DATE_ISO` constant is already defined at line 18 of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai-seo-p0.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/seo/seo-pages.ts tests/ai-seo-p0.test.ts
git commit -m "feat: add dateModified to all Dataset schemas for Google Dataset Search freshness"
```

---

### Task 4: Add totalTime to HowTo schemas

5 of 6 HowTo schemas lack `totalTime`. Only the calculator HowTo has it (PT1M). Adding estimated completion times improves rich result eligibility.

**Files:**
- Modify: `services/seo/seo-pages.ts` (5 HowTo entries)
- Test: `tests/ai-seo-p0.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/ai-seo-p0.test.ts`:

```typescript
describe('AI SEO P0: HowTo totalTime', () => {
  it('all HowTo schemas should have totalTime', async () => {
    const mod = await import('../services/seo/seo-pages.ts');
    const metadata = (mod as Record<string, unknown>).default ?? Object.values(mod).find(v => typeof v === 'object' && v !== null && !Array.isArray(v));
    if (!metadata || typeof metadata !== 'object') return;

    for (const [key, entry] of Object.entries(metadata as Record<string, { structuredData?: Record<string, unknown> | Record<string, unknown>[] }>)) {
      const sd = entry.structuredData;
      if (!sd) continue;
      const schemas = Array.isArray(sd) ? sd : [sd];
      for (const schema of schemas) {
        if (schema['@type'] === 'HowTo') {
          expect(schema, `HowTo in "${key}" missing totalTime`).toHaveProperty('totalTime');
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai-seo-p0.test.ts`
Expected: FAIL — 5 HowTo schemas lack totalTime

- [ ] **Step 3: Add totalTime to each HowTo**

In `services/seo/seo-pages.ts`, find each `"@type": "HowTo"` block and add appropriate `totalTime` values:

| HowTo | totalTime | Rationale |
|-------|-----------|-----------|
| Calculator (already has PT1M) | PT1M | Keep |
| Car transfer | PT30M | Multi-step bureaucratic process |
| First day guide | PT15M | Reading + planning checklist |
| Tax return IT | PT45M | Filling out tax declaration |
| Tax return Italy | PT60M | Italian tax return is complex |
| Tax return CH | PT30M | Swiss tax declaration |

Add `"totalTime": "PT30M"` (or appropriate value) to each HowTo object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai-seo-p0.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/seo/seo-pages.ts tests/ai-seo-p0.test.ts
git commit -m "feat: add totalTime to all HowTo schemas for richer search results"
```

---

### Task 5: Build verification and full test suite

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Production build**

Run: `npx vite build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 4: Spot-check schema in built pages**

```bash
# Check a Dataset page for dateModified
grep -o '"@type":"Dataset"[^}]*dateModified[^"]*"[^"]*"' dist/statistiche/confronta-stipendi/index.html | head -1

# Check an article page for Organization author (no Person)
grep -o '"author":{[^}]*}' dist/articoli-frontaliere/a13-cantieri-frontalieri-ticino/index.html | head -1

# Check a tool page for visible date
grep "Ultimo aggiornamento" dist/calcola-stipendio/simula-busta-paga/index.html | head -1
```

- [ ] **Step 5: Final commit and push**

```bash
git add -A
git commit -m "feat: AI SEO P0 — visible dates, honest author, Dataset dates, HowTo times"
git push
```
