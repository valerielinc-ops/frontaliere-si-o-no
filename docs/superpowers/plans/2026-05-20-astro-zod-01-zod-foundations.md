# Sub-Plan 01: Zod Foundations + JSON-LD Schema-Derived Emission

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install Zod. Define schemas for the 6 most-referenced content/data sources. Refactor JSON-LD emission to be schema-derived. Retire 7 dist-walking audit gates by making the violations they catch impossible by construction at assemble-time / build-time.

**Architecture:** Schemas live under `scripts/lib/schemas/` (Node-side, ESM, importable from both `.mjs` scripts and `.ts` build plugins via the existing path alias `@/*`). Each data source has a strict Zod schema parsed at the boundary (assembler, AI output parser, plugin entry). Schema-derived JSON-LD helpers live in `services/seo/structuredData.ts` (refactor of the existing `services/seo/imageObjectLd.ts`). Audit retirement = delete the audit from `audit-all.mjs` registry + delete its baseline file + delete its workflow step; the corresponding invariant is enforced at the source by the schema or by the JSON-LD helper.

**Tech Stack:** Zod 4.4.x (devDep), Node ESM, existing vitest, existing JSON-LD emission pattern (`services/seo/imageObjectLd.ts` as the reference shape).

**Ships standalone value:** ✅ Even if the rest of the Astro migration is cancelled, this sub-plan eliminates 7 audit gates, hardens AI output parsing, and produces typed data sources that the rest of the codebase can consume.

---

## File structure

**Created:**
- `scripts/lib/schemas/index.mjs` — barrel export
- `scripts/lib/schemas/job.mjs` — `JobSchema`, `LocalizedJobSchema`
- `scripts/lib/schemas/article.mjs` — `ArticleMetaSchema`, `ArticleLocaleBodySchema`, `LocalizedArticleSchema`
- `scripts/lib/schemas/orphanCluster.mjs` — `OrphanClusterSchema`
- `scripts/lib/schemas/healthPremium.mjs` — `HealthPremiumRowSchema`
- `scripts/lib/schemas/fuelDaily.mjs` — `FuelDailySnapshotSchema`
- `scripts/lib/schemas/borderWait.mjs` — `BorderWaitMeasurementSchema`
- `scripts/lib/schemas/seoText.mjs` — `SeoTitleSchema`, `SeoH1Schema`, `SeoMetaDescriptionSchema` (reusable string constraints)
- `services/seo/structuredData.ts` — schema-driven JSON-LD emitters
- `tests/schemas/job-schema.test.ts`
- `tests/schemas/article-schema.test.ts`
- `tests/schemas/orphan-cluster-schema.test.ts`
- `tests/schemas/health-premium-schema.test.ts`
- `tests/schemas/fuel-daily-schema.test.ts`
- `tests/schemas/border-wait-schema.test.ts`
- `tests/schemas/seo-text-schema.test.ts`
- `tests/seo/structured-data.test.ts`
- `tests/assemble-jobs-schema-gate.test.ts` — integration test that the assembler rejects invalid jobs

**Modified:**
- `package.json` — add `zod` to `devDependencies`
- `scripts/assemble-jobs-dataset.mjs` — import `JobSchema`, validate at write time
- `scripts/cluster-orphan-queries.mjs` — import `OrphanClusterSchema`, validate at write time
- `scripts/create-article.mjs` — import `ArticleMetaSchema`, validate AI output before write
- `services/seo/imageObjectLd.ts` — re-export from new `structuredData.ts`, deprecation comment
- `scripts/audit-all.mjs` — remove 7 retired audits from registry
- `.github/workflows/deploy.yml` — remove 7 retired audit steps (or mark as build-time-handled)
- `.github/workflows/post-deploy-validate-dist.yml` — same

**Deleted (after schema fully replaces them):**
- `scripts/audit-title-length.mjs`
- `scripts/audit-title-no-disambig-hash.mjs`
- `scripts/audit-h1-title-duplicates.mjs`
- `scripts/audit-jsonld-no-nested-scripts.mjs` (and any `*.cjs` variants)
- `scripts/audit-image-object-license.mjs`
- `scripts/audit-faqpage-validity.mjs`
- `scripts/audit-footer-root-presence.mjs`
- Corresponding baseline JSON files in `data/*-baseline.json`

---

## Task 1: Install Zod

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Verify Zod is not already a transitive runtime dependency we shouldn't conflict with**

Run: `npm ls zod 2>&1 | head -20`
Expected: only transitive entries (e.g. from openai SDK if present), no top-level dependency.

- [ ] **Step 2: Install Zod as devDependency**

Run: `npm install --save-dev zod@^4.4.3`
Expected: `package.json` `devDependencies` now includes `"zod": "^4.4.3"`. `package-lock.json` updated.

- [ ] **Step 3: Verify install works**

Run: `node -e "import('zod').then(z => console.log(z.z.string().parse('hello')))"`
Expected output: `hello`

- [ ] **Step 4: Type-check still clean**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: no new errors introduced.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add zod 4.4.x as devDependency for schema-driven validation"
```

---

## Task 2: Create reusable SeoText schemas (string constraints)

**Files:**
- Create: `scripts/lib/schemas/seoText.mjs`
- Test: `tests/schemas/seo-text-schema.test.ts`

- [ ] **Step 1: Write failing test for SeoTitleSchema length cap**

```ts
// tests/schemas/seo-text-schema.test.ts
import { describe, it, expect } from 'vitest';
import { SeoTitleSchema, SeoH1Schema, SeoMetaDescriptionSchema } from '../../scripts/lib/schemas/seoText.mjs';

describe('SeoTitleSchema', () => {
  it('accepts a 1-66 char title', () => {
    expect(SeoTitleSchema.safeParse('Stipendio netto frontaliere 2026').success).toBe(true);
  });
  it('rejects empty title', () => {
    expect(SeoTitleSchema.safeParse('').success).toBe(false);
  });
  it('rejects title > 66 chars', () => {
    const tooLong = 'A'.repeat(67);
    expect(SeoTitleSchema.safeParse(tooLong).success).toBe(false);
  });
  it('rejects title containing (#hash) disambiguation marker', () => {
    expect(SeoTitleSchema.safeParse('Permesso G vs B (#1)').success).toBe(false);
  });
});

describe('SeoH1Schema', () => {
  it('accepts a 1-80 char H1', () => {
    expect(SeoH1Schema.safeParse('Stipendio netto frontaliere 2026 — guida').success).toBe(true);
  });
  it('rejects empty H1', () => {
    expect(SeoH1Schema.safeParse('').success).toBe(false);
  });
});

describe('SeoMetaDescriptionSchema', () => {
  it('accepts 50-160 chars', () => {
    const ok = 'A'.repeat(120);
    expect(SeoMetaDescriptionSchema.safeParse(ok).success).toBe(true);
  });
  it('rejects < 50 chars (thin content)', () => {
    expect(SeoMetaDescriptionSchema.safeParse('too short').success).toBe(false);
  });
  it('rejects > 160 chars', () => {
    const tooLong = 'A'.repeat(161);
    expect(SeoMetaDescriptionSchema.safeParse(tooLong).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx vitest run tests/schemas/seo-text-schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the schema module**

```js
// scripts/lib/schemas/seoText.mjs
import { z } from 'zod';

// Caps tracked from CLAUDE.md SEO gates table. Title cap = 66 (gate threshold);
// H1 cap = 80 (per repo convention, h1 may be longer than title); meta description
// 50-160 per Google snippet rendering window.
export const SeoTitleSchema = z
  .string()
  .min(1, 'title-empty')
  .max(66, 'title-too-long')
  .refine((s) => !/\(#[^)]*\)/.test(s), {
    message: 'title-contains-disambig-hash',
  });

export const SeoH1Schema = z.string().min(1, 'h1-empty').max(80, 'h1-too-long');

export const SeoMetaDescriptionSchema = z
  .string()
  .min(50, 'meta-description-too-short')
  .max(160, 'meta-description-too-long');
```

- [ ] **Step 4: Run test — verify it passes**

Run: `npx vitest run tests/schemas/seo-text-schema.test.ts`
Expected: PASS (10 assertions).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/schemas/seoText.mjs tests/schemas/seo-text-schema.test.ts
git commit -m "feat(schemas): add SeoTitleSchema, SeoH1Schema, SeoMetaDescriptionSchema"
```

---

## Task 3: JobSchema — strict shape for assembled jobs

**Files:**
- Create: `scripts/lib/schemas/job.mjs`
- Test: `tests/schemas/job-schema.test.ts`

**Pre-read context:** Inspect `scripts/assemble-jobs-dataset.mjs:698` (HEAVY_FIELDS), `:1570-1590` (postalCode enrichment) to confirm field names. Also inspect one slice file under `data/jobs/by-crawler/` to see the post-assembly shape on disk.

- [ ] **Step 1: Read a real job to anchor the schema**

Run: `node -e "import('fs').then(({readFileSync}) => { const f = JSON.parse(readFileSync('data/jobs/by-crawler/vaudoise.json','utf8')); console.log(JSON.stringify(f.jobs?.[0] ?? f[0], null, 2).slice(0, 2000)); })"`
Expected: prints the shape of one job. Note any field present in real data that the test below should accept.

- [ ] **Step 2: Write failing test for JobSchema**

```ts
// tests/schemas/job-schema.test.ts
import { describe, it, expect } from 'vitest';
import { JobSchema } from '../../scripts/lib/schemas/job.mjs';

const validJob = {
  id: 'vaudoise-12345',
  stableId: '550e8400-e29b-41d4-a716-446655440000',
  slug: 'sviluppatore-frontend-lausanne',
  url: 'https://vaudoise.ch/jobs/12345',
  title: 'Sviluppatore Frontend',
  company: 'Vaudoise Assurances',
  hiringOrganization: { name: 'Vaudoise Assurances' },
  location: 'Lausanne',
  addressLocality: 'Lausanne',
  postalCode: '1003',
  streetAddress: 'Place de Milan 1',
  description: 'Cerchiamo uno sviluppatore frontend con esperienza in React per la nostra sede di Losanna. Lavorerai in un team di 8 persone.',
  datePosted: '2026-05-15',
  employmentType: 'FULL_TIME',
  jobLocation: {
    addressLocality: 'Lausanne',
    postalCode: '1003',
    addressCountry: 'CH',
  },
  baseSalary: {
    currency: 'CHF',
    value: { minValue: 80000, maxValue: 110000, unitText: 'YEAR' },
  },
};

describe('JobSchema', () => {
  it('accepts a fully-populated job', () => {
    const res = JobSchema.safeParse(validJob);
    if (!res.success) console.error(res.error.issues);
    expect(res.success).toBe(true);
  });

  it('rejects job without baseSalary (CLAUDE.md rule #3)', () => {
    const { baseSalary, ...without } = validJob;
    expect(JobSchema.safeParse(without).success).toBe(false);
  });

  it('rejects job without postalCode', () => {
    const { postalCode, ...without } = validJob;
    expect(JobSchema.safeParse(without).success).toBe(false);
  });

  it('rejects job without streetAddress', () => {
    const { streetAddress, ...without } = validJob;
    expect(JobSchema.safeParse(without).success).toBe(false);
  });

  it('rejects job with description < 50 chars (thin content, rule #4)', () => {
    const thin = { ...validJob, description: 'too short' };
    expect(JobSchema.safeParse(thin).success).toBe(false);
  });

  it('rejects job with title > 66 chars', () => {
    const longTitle = { ...validJob, title: 'A'.repeat(67) };
    expect(JobSchema.safeParse(longTitle).success).toBe(false);
  });

  it('rejects malformed postalCode (must be 4 digits)', () => {
    const bad = { ...validJob, postalCode: 'CH-1003' };
    expect(JobSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown employmentType', () => {
    const bad = { ...validJob, employmentType: 'GIG_WORK' };
    expect(JobSchema.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run test — verify it fails**

Run: `npx vitest run tests/schemas/job-schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Create JobSchema**

```js
// scripts/lib/schemas/job.mjs
import { z } from 'zod';
import { SeoTitleSchema } from './seoText.mjs';

// Swiss postal codes are 4 digits (Liechtenstein included).
const SwissPostalCodeSchema = z.string().regex(/^\d{4}$/, 'postalCode-not-swiss-4-digit');

const BaseSalarySchema = z.object({
  currency: z.literal('CHF'),
  value: z.object({
    minValue: z.number().nonnegative(),
    maxValue: z.number().nonnegative(),
    unitText: z.enum(['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR']),
  }),
});

const EmploymentTypeSchema = z.enum([
  'FULL_TIME',
  'PART_TIME',
  'CONTRACTOR',
  'TEMPORARY',
  'INTERN',
  'VOLUNTEER',
  'PER_DIEM',
  'OTHER',
]);

const JobLocationSchema = z.object({
  addressLocality: z.string().min(1),
  postalCode: SwissPostalCodeSchema,
  addressCountry: z.enum(['CH', 'LI', 'IT', 'FR', 'DE', 'AT']),
});

// JobSchema enforces every mandatory SEO field listed in CLAUDE.md rule #3.
// Optional fields (titleByLocale, descriptionByLocale, previousSlugs, etc.) are
// passed through with .passthrough() to preserve enrichment without re-listing.
export const JobSchema = z
  .object({
    id: z.string().min(1),
    stableId: z.string().uuid().optional(),  // crawler-derived, may be absent on legacy slices
    slug: z.string().min(1),
    url: z.string().url(),
    title: SeoTitleSchema,
    company: z.string().min(1),
    hiringOrganization: z.object({ name: z.string().min(1) }),
    location: z.string().min(1),
    addressLocality: z.string().min(1),
    postalCode: SwissPostalCodeSchema,
    streetAddress: z.string().min(1),
    description: z.string().min(50, 'thin-content-rule-4'),
    datePosted: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'datePosted-not-iso'),
    employmentType: EmploymentTypeSchema,
    jobLocation: JobLocationSchema,
    baseSalary: BaseSalarySchema,
  })
  .passthrough();

// Per-locale renderable view (combined with titleByLocale/descriptionByLocale at render time).
export const LocalizedJobSchema = JobSchema.extend({
  locale: z.enum(['it', 'en', 'de', 'fr']),
});
```

- [ ] **Step 5: Run test — verify it passes**

Run: `npx vitest run tests/schemas/job-schema.test.ts`
Expected: PASS (8 assertions).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/schemas/job.mjs tests/schemas/job-schema.test.ts
git commit -m "feat(schemas): add JobSchema enforcing CLAUDE.md rule #3 mandatory SEO fields"
```

---

## Task 4: Wire JobSchema into assemble-jobs-dataset.mjs

**Files:**
- Modify: `scripts/assemble-jobs-dataset.mjs`
- Test: `tests/assemble-jobs-schema-gate.test.ts`

- [ ] **Step 1: Write integration test that the assembler rejects malformed jobs**

```ts
// tests/assemble-jobs-schema-gate.test.ts
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('assemble-jobs-dataset schema gate', () => {
  it('exits non-zero when a slice contains a job missing baseSalary', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'assemble-gate-'));
    const byCrawler = join(tmp, 'data', 'jobs', 'by-crawler');
    mkdirSync(byCrawler, { recursive: true });

    const malformed = {
      crawlerKey: 'unit-test',
      assembledAt: new Date().toISOString(),
      jobs: [
        {
          id: 'broken-1',
          slug: 'broken-1',
          url: 'https://example.ch/broken-1',
          title: 'No salary here',
          company: 'Acme',
          hiringOrganization: { name: 'Acme' },
          location: 'Lugano',
          addressLocality: 'Lugano',
          postalCode: '6900',
          streetAddress: 'Via Test 1',
          description: 'A'.repeat(100),
          datePosted: '2026-05-15',
          employmentType: 'FULL_TIME',
          jobLocation: { addressLocality: 'Lugano', postalCode: '6900', addressCountry: 'CH' },
          // baseSalary intentionally missing
        },
      ],
    };
    writeFileSync(join(byCrawler, 'unit-test.json'), JSON.stringify(malformed));

    let exitCode = 0;
    try {
      execSync(`SLICES_DIR=${byCrawler} node scripts/assemble-jobs-dataset.mjs --validate-only`, { stdio: 'pipe' });
    } catch (e: any) {
      exitCode = e.status ?? 1;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    expect(exitCode).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx vitest run tests/assemble-jobs-schema-gate.test.ts`
Expected: FAIL — assembler does not yet validate.

- [ ] **Step 3: Locate the assembler's write-out section**

Run: `grep -n "writeFileSync\|JSON.stringify.*jobs\|jobs\.json" scripts/assemble-jobs-dataset.mjs | head -20`
Note line numbers of the final write block and any pre-existing CLI flag parsing.

- [ ] **Step 4: Add SLICES_DIR override + --validate-only flag + JobSchema validation**

In `scripts/assemble-jobs-dataset.mjs`, near the top imports add:

```js
import { JobSchema } from './lib/schemas/job.mjs';
```

Near the CLI flag parsing (search for `--stats` to find it), add:

```js
const VALIDATE_ONLY = process.argv.includes('--validate-only');
const SLICES_DIR = process.env.SLICES_DIR || 'data/jobs/by-crawler';
```

(Update any existing literal `'data/jobs/by-crawler'` reads to use `SLICES_DIR`.)

After all jobs are merged into the final array but before `writeFileSync`, add:

```js
// Schema gate — fails the build on any job missing CLAUDE.md rule #3 fields.
const violations = [];
for (const job of finalJobs) {
  const result = JobSchema.safeParse(job);
  if (!result.success) {
    violations.push({ id: job.id, issues: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
  }
}
if (violations.length > 0) {
  console.error(`[assemble-jobs] ${violations.length} job(s) failed JobSchema validation:`);
  for (const v of violations.slice(0, 20)) {
    console.error(`  - ${v.id}: ${v.issues.join('; ')}`);
  }
  if (violations.length > 20) console.error(`  ... and ${violations.length - 20} more`);
  process.exit(1);
}

if (VALIDATE_ONLY) {
  console.log(`[assemble-jobs] --validate-only OK: ${finalJobs.length} jobs pass JobSchema`);
  process.exit(0);
}
```

- [ ] **Step 5: Run integration test — verify it passes**

Run: `npx vitest run tests/assemble-jobs-schema-gate.test.ts`
Expected: PASS.

- [ ] **Step 6: Run assembler on real data, expect either pass or actionable failures**

Run: `node scripts/assemble-jobs-dataset.mjs --stats 2>&1 | tail -40`
Expected: either `OK` exit 0 with stats, OR a list of violations — in which case, **DO NOT** loosen the schema. Fix the offending crawler slices in a separate PR, then resume.

- [ ] **Step 7: Commit**

```bash
git add scripts/assemble-jobs-dataset.mjs tests/assemble-jobs-schema-gate.test.ts
git commit -m "feat(jobs): gate assemble-jobs-dataset on JobSchema; rule #3 enforced at assemble-time"
```

---

## Task 5: ArticleMetaSchema — strict shape for blog-articles-data.ts entries

**Files:**
- Create: `scripts/lib/schemas/article.mjs`
- Test: `tests/schemas/article-schema.test.ts`

- [ ] **Step 1: Read one ARTICLES entry to anchor the schema**

Run: `grep -A 15 "^export const ARTICLES" data/blog-articles-data.ts | head -25`
Confirm fields: `id`, `category`, `date`, `updatedAt`, `image`, `hasCalculator`, `authorSlug`, `authorName`.

- [ ] **Step 2: Write failing test**

```ts
// tests/schemas/article-schema.test.ts
import { describe, it, expect } from 'vitest';
import { ArticleMetaSchema, LocalizedArticleSchema } from '../../scripts/lib/schemas/article.mjs';

const validMeta = {
  id: 'stipendio-netto-2026',
  category: 'fisco',
  date: '2026-01-15',
  image: '/images/articles/stipendio-netto-2026.webp',
  hasCalculator: true,
  authorSlug: 'valerie-linc',
  authorName: 'Valerie Linc',
};

describe('ArticleMetaSchema', () => {
  it('accepts a full metadata entry', () => {
    const r = ArticleMetaSchema.safeParse(validMeta);
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });
  it('accepts optional updatedAt', () => {
    expect(ArticleMetaSchema.safeParse({ ...validMeta, updatedAt: '2026-05-01' }).success).toBe(true);
  });
  it('rejects missing id', () => {
    const { id, ...without } = validMeta;
    expect(ArticleMetaSchema.safeParse(without).success).toBe(false);
  });
  it('rejects id with uppercase (slug rule)', () => {
    expect(ArticleMetaSchema.safeParse({ ...validMeta, id: 'Stipendio-Netto' }).success).toBe(false);
  });
  it('rejects malformed date', () => {
    expect(ArticleMetaSchema.safeParse({ ...validMeta, date: '15/01/2026' }).success).toBe(false);
  });
  it('rejects category outside known set', () => {
    expect(ArticleMetaSchema.safeParse({ ...validMeta, category: 'unknown' }).success).toBe(false);
  });
});

describe('LocalizedArticleSchema', () => {
  it('accepts metadata + locale + bodyHtml + title + excerpt', () => {
    const localized = {
      ...validMeta,
      locale: 'it' as const,
      title: 'Stipendio netto frontaliere 2026: come calcolarlo',
      excerpt: 'Una guida completa per calcolare lo stipendio netto del frontaliere svizzero nel 2026, con esempi pratici e simulatore.',
      bodyHtml: '<p>Test body.</p>'.padEnd(200, ' '),
    };
    expect(LocalizedArticleSchema.safeParse(localized).success).toBe(true);
  });
  it('rejects body < 50 words (thin content rule #4)', () => {
    const thin = {
      ...validMeta,
      locale: 'it' as const,
      title: 'OK',
      excerpt: 'A'.repeat(80),
      bodyHtml: '<p>too short</p>',
    };
    expect(LocalizedArticleSchema.safeParse(thin).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run test — verify it fails**

Run: `npx vitest run tests/schemas/article-schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Create the schema**

```js
// scripts/lib/schemas/article.mjs
import { z } from 'zod';
import { SeoTitleSchema, SeoMetaDescriptionSchema } from './seoText.mjs';

// Known categories from current blog-articles-data.ts. Update list when adding categories.
const CategorySchema = z.enum([
  'fisco',
  'lavoro',
  'salute',
  'casa',
  'mobilita',
  'famiglia',
  'previdenza',
  'finanze',
  'guide',
  'attualita',
]);

const SlugSchema = z
  .string()
  .min(1, 'slug-empty')
  .max(120, 'slug-too-long')
  .regex(/^[a-z0-9-]+$/, 'slug-invalid-chars');

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date-not-iso');

export const ArticleMetaSchema = z.object({
  id: SlugSchema,
  category: CategorySchema,
  date: IsoDateSchema,
  updatedAt: IsoDateSchema.optional(),
  image: z.string().min(1),
  hasCalculator: z.boolean(),
  authorSlug: z.string().min(1).optional(),
  authorName: z.string().min(1).optional(),
});

// A roughly-rendered article (after merging metadata + locale strings + body).
// Used by create-article.mjs AI output validation and at MDX-emission boundary.
const wordCount = (html) => (html.replace(/<[^>]*>/g, ' ').match(/\S+/g) ?? []).length;

export const ArticleLocaleBodySchema = z.string().refine((html) => wordCount(html) >= 50, {
  message: 'thin-content-rule-4-body-under-50-words',
});

export const LocalizedArticleSchema = ArticleMetaSchema.extend({
  locale: z.enum(['it', 'en', 'de', 'fr']),
  title: SeoTitleSchema,
  excerpt: SeoMetaDescriptionSchema,
  bodyHtml: ArticleLocaleBodySchema,
});
```

- [ ] **Step 5: Run test — verify it passes**

Run: `npx vitest run tests/schemas/article-schema.test.ts`
Expected: PASS (8 assertions).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/schemas/article.mjs tests/schemas/article-schema.test.ts
git commit -m "feat(schemas): add ArticleMetaSchema + LocalizedArticleSchema with thin-content gate"
```

---

## Task 6: Wire ArticleMetaSchema into create-article.mjs AI output validation

**Files:**
- Modify: `scripts/create-article.mjs`

- [ ] **Step 1: Locate the AI response parse site**

Run: `grep -n "JSON.parse\|AI.*response\|ai_response\|extractArticleFrom" scripts/create-article.mjs | head -20`
Note the line where the LLM output is first parsed as JSON.

- [ ] **Step 2: Import LocalizedArticleSchema near the top of the file**

```js
import { LocalizedArticleSchema, ArticleMetaSchema } from './lib/schemas/article.mjs';
```

- [ ] **Step 3: Wrap the JSON.parse with safeParse + retry on fail**

Replace the unwrapped `JSON.parse(llmRaw)` site with a validation block. The actual AI response shape in this repo varies — read the existing parse + transform code to find what shape goes into the file write. The new pattern:

```js
// After the AI response is parsed and merged into the final article object:
const validation = LocalizedArticleSchema.safeParse(articleForWrite);
if (!validation.success) {
  const issues = validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  console.error(`[create-article] AI output failed schema validation: ${issues}`);
  // Retry guidance — caller decides whether to re-prompt or abort.
  throw new Error(`AI_OUTPUT_INVALID: ${issues}`);
}
```

- [ ] **Step 4: Smoke test against a recent article that should be valid**

Run: `node -e "import('./scripts/lib/schemas/article.mjs').then(async ({LocalizedArticleSchema}) => { const fs = await import('node:fs'); const m = JSON.parse(fs.readFileSync('data/blog-articles/abbonamento-newsletter-ticino-2026.json','utf8')); console.log(LocalizedArticleSchema.safeParse({...m, locale:'it', title:m.title||'placeholder',excerpt:'a'.repeat(80),bodyHtml:'<p>'+ 'word '.repeat(60) +'</p>'}).success ? 'OK' : 'FAIL'); })"`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add scripts/create-article.mjs
git commit -m "feat(articles): gate create-article.mjs AI output on LocalizedArticleSchema"
```

---

## Task 7: OrphanClusterSchema + cluster-orphan-queries.mjs gate

**Files:**
- Create: `scripts/lib/schemas/orphanCluster.mjs`
- Test: `tests/schemas/orphan-cluster-schema.test.ts`
- Modify: `scripts/cluster-orphan-queries.mjs`

- [ ] **Step 1: Read a real cluster to anchor the schema**

Run: `head -200 data/gsc-orphan-queries-clusters.json | python3 -c "import sys, json; d = json.loads(open('data/gsc-orphan-queries-clusters.json').read()); print(json.dumps((d if isinstance(d,list) else d.get('clusters', []))[:1], indent=2)[:2000])"`
Confirm cluster shape: `id/slug`, `canonicalQuery`, `roleTokens[]`, `regionTokens[]`, `queries[]`, etc.

- [ ] **Step 2: Write failing test**

```ts
// tests/schemas/orphan-cluster-schema.test.ts
import { describe, it, expect } from 'vitest';
import { OrphanClusterSchema } from '../../scripts/lib/schemas/orphanCluster.mjs';

const valid = {
  id: 'lavoro-magazziniere-ticino',
  slug: 'lavoro-magazziniere-ticino',
  canonicalQuery: 'lavoro magazziniere ticino',
  roleTokens: ['magazziniere', 'logistica'],
  regionTokens: ['ticino', 'lugano'],
  queries: [
    { query: 'lavoro magazziniere ticino', impressions: 120, clicks: 4 },
    { query: 'magazziniere lugano', impressions: 80, clicks: 2 },
  ],
};

describe('OrphanClusterSchema', () => {
  it('accepts a valid cluster', () => {
    const r = OrphanClusterSchema.safeParse(valid);
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });
  it('rejects empty queries', () => {
    expect(OrphanClusterSchema.safeParse({ ...valid, queries: [] }).success).toBe(false);
  });
  it('rejects missing canonicalQuery', () => {
    const { canonicalQuery, ...without } = valid;
    expect(OrphanClusterSchema.safeParse(without).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run test — verify it fails**

Run: `npx vitest run tests/schemas/orphan-cluster-schema.test.ts`
Expected: FAIL.

- [ ] **Step 4: Create the schema**

```js
// scripts/lib/schemas/orphanCluster.mjs
import { z } from 'zod';

const SlugSchema = z.string().min(1).regex(/^[a-z0-9-]+$/);

const OrphanQuerySchema = z.object({
  query: z.string().min(1),
  impressions: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
});

export const OrphanClusterSchema = z.object({
  id: SlugSchema,
  slug: SlugSchema,
  canonicalQuery: z.string().min(1),
  roleTokens: z.array(z.string().min(1)).min(1),
  regionTokens: z.array(z.string().min(1)),
  queries: z.array(OrphanQuerySchema).min(1),
}).passthrough();
```

- [ ] **Step 5: Run test — verify it passes**

Run: `npx vitest run tests/schemas/orphan-cluster-schema.test.ts`
Expected: PASS (3 assertions).

- [ ] **Step 6: Wire into cluster-orphan-queries.mjs at write site**

Locate the writeFileSync of the clusters JSON:
Run: `grep -n "writeFileSync\|JSON.stringify.*cluster" scripts/cluster-orphan-queries.mjs`

At the write site, prepend:

```js
import { OrphanClusterSchema } from './lib/schemas/orphanCluster.mjs';

// Then before the writeFileSync:
const clusterViolations = [];
for (const c of clustersToWrite) {
  const r = OrphanClusterSchema.safeParse(c);
  if (!r.success) clusterViolations.push({ id: c.id ?? c.slug ?? '?', issues: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
}
if (clusterViolations.length > 0) {
  console.error(`[cluster-orphan-queries] ${clusterViolations.length} cluster(s) failed schema:`);
  for (const v of clusterViolations.slice(0, 10)) console.error(`  - ${v.id}: ${v.issues.join('; ')}`);
  process.exit(1);
}
```

- [ ] **Step 7: Run the cluster script and confirm it still completes**

Run: `node scripts/cluster-orphan-queries.mjs 2>&1 | tail -20`
Expected: completes with stats or fails with actionable cluster IDs (fix data, do not loosen schema).

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/schemas/orphanCluster.mjs tests/schemas/orphan-cluster-schema.test.ts scripts/cluster-orphan-queries.mjs
git commit -m "feat(orphan): gate cluster-orphan-queries on OrphanClusterSchema"
```

---

## Task 8: HealthPremiumRowSchema + producer-side gate

**Files:**
- Create: `scripts/lib/schemas/healthPremium.mjs`
- Test: `tests/schemas/health-premium-schema.test.ts`
- Modify: the script that writes `data/health-premiums*.json` (locate via grep)

- [ ] **Step 1: Locate the producer script and read one row**

Run: `grep -rln "health-premium\|healthPremium\|premio.*malattia" scripts/ | head -10` then read the writer.
Run: `ls data/ | grep -i premium`

- [ ] **Step 2: Write failing test for HealthPremiumRowSchema**

```ts
// tests/schemas/health-premium-schema.test.ts
import { describe, it, expect } from 'vitest';
import { HealthPremiumRowSchema } from '../../scripts/lib/schemas/healthPremium.mjs';

const valid = {
  canton: 'TI',
  region: 'PR-TI1',
  ageGroup: 'AKL-ADU',
  accidentCover: 'OUI',
  insurer: 'CSS',
  product: 'Basis',
  monthlyPremiumChf: 412.50,
  year: 2026,
};

describe('HealthPremiumRowSchema', () => {
  it('accepts a valid row', () => {
    const r = HealthPremiumRowSchema.safeParse(valid);
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });
  it('rejects negative premium', () => {
    expect(HealthPremiumRowSchema.safeParse({ ...valid, monthlyPremiumChf: -10 }).success).toBe(false);
  });
  it('rejects out-of-range year', () => {
    expect(HealthPremiumRowSchema.safeParse({ ...valid, year: 1990 }).success).toBe(false);
  });
  it('rejects unknown canton code', () => {
    expect(HealthPremiumRowSchema.safeParse({ ...valid, canton: 'XX' }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run test — verify it fails**

Run: `npx vitest run tests/schemas/health-premium-schema.test.ts`
Expected: FAIL.

- [ ] **Step 4: Create the schema**

```js
// scripts/lib/schemas/healthPremium.mjs
import { z } from 'zod';

const CantonSchema = z.enum([
  'AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU','NE','NW','OW',
  'SG','SH','SO','SZ','TG','TI','UR','VD','VS','ZG','ZH',
]);

const AgeGroupSchema = z.enum(['AKL-KIN', 'AKL-JUG', 'AKL-ADU']);
const AccidentCoverSchema = z.enum(['OUI', 'NON']);

export const HealthPremiumRowSchema = z.object({
  canton: CantonSchema,
  region: z.string().regex(/^PR-[A-Z]{2}\d+$/, 'region-not-bag-format'),
  ageGroup: AgeGroupSchema,
  accidentCover: AccidentCoverSchema,
  insurer: z.string().min(1),
  product: z.string().min(1),
  monthlyPremiumChf: z.number().positive(),
  year: z.number().int().min(2024).max(2030),
}).passthrough();
```

- [ ] **Step 5: Run test — verify it passes**

Run: `npx vitest run tests/schemas/health-premium-schema.test.ts`
Expected: PASS (4 assertions).

- [ ] **Step 6: Wire into the producer script (same pattern as Task 4 / Task 7)**

Import the schema, validate every row before write, exit non-zero on violations.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/schemas/healthPremium.mjs tests/schemas/health-premium-schema.test.ts scripts/<producer>.mjs
git commit -m "feat(health-premiums): gate producer on HealthPremiumRowSchema"
```

---

## Task 9: FuelDailySnapshotSchema + producer gate

**Files:**
- Create: `scripts/lib/schemas/fuelDaily.mjs`
- Test: `tests/schemas/fuel-daily-schema.test.ts`
- Modify: producer (search via `grep -rln "fuel.*daily\|carburante" scripts/ | head`)

Mirror Task 8 structure exactly. Schema fields (confirm against real JSON):

```js
// scripts/lib/schemas/fuelDaily.mjs
import { z } from 'zod';

export const FuelDailySnapshotSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fuelType: z.enum(['benzina', 'diesel', 'gpl', 'metano']),
  countryAvgChf: z.number().positive(),
  countryAvgEur: z.number().positive(),
  pricesByCanton: z.record(z.string(), z.number().positive()),
}).passthrough();
```

Test + wire-in + commit as before.

```bash
git commit -m "feat(fuel-daily): gate producer on FuelDailySnapshotSchema"
```

---

## Task 10: BorderWaitMeasurementSchema + producer gate

**Files:**
- Create: `scripts/lib/schemas/borderWait.mjs`
- Test: `tests/schemas/border-wait-schema.test.ts`
- Modify: producer for `data/border-wait-current.json` + `data/border-wait-history/`

Mirror Task 8. Schema:

```js
// scripts/lib/schemas/borderWait.mjs
import { z } from 'zod';

export const BorderWaitMeasurementSchema = z.object({
  crossing: z.string().min(1),
  observedAt: z.string().datetime(),
  waitMinutes: z.number().int().min(0).max(720),
  direction: z.enum(['IT->CH', 'CH->IT']),
  source: z.enum(['ti-camera', 'sferanet', 'fl', 'crowdsourced']),
}).passthrough();
```

Test + wire-in + commit.

```bash
git commit -m "feat(border-wait): gate producer on BorderWaitMeasurementSchema"
```

---

## Task 11: Schemas barrel export

**Files:**
- Create: `scripts/lib/schemas/index.mjs`

- [ ] **Step 1: Create barrel**

```js
// scripts/lib/schemas/index.mjs
export * from './seoText.mjs';
export * from './job.mjs';
export * from './article.mjs';
export * from './orphanCluster.mjs';
export * from './healthPremium.mjs';
export * from './fuelDaily.mjs';
export * from './borderWait.mjs';
```

- [ ] **Step 2: Smoke test the barrel**

Run: `node -e "import('./scripts/lib/schemas/index.mjs').then(m => console.log(Object.keys(m).sort()))"`
Expected: lists `ArticleMetaSchema`, `BorderWaitMeasurementSchema`, `FuelDailySnapshotSchema`, `HealthPremiumRowSchema`, `JobSchema`, `LocalizedArticleSchema`, `LocalizedJobSchema`, `OrphanClusterSchema`, `SeoH1Schema`, `SeoMetaDescriptionSchema`, `SeoTitleSchema`.

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/schemas/index.mjs
git commit -m "feat(schemas): add barrel export"
```

---

## Task 12: Schema-derived JSON-LD helpers (structuredData.ts)

**Files:**
- Create: `services/seo/structuredData.ts`
- Test: `tests/seo/structured-data.test.ts`
- Modify: `services/seo/imageObjectLd.ts` (re-export from new module, mark deprecated)

- [ ] **Step 1: Write failing tests for helpers**

```ts
// tests/seo/structured-data.test.ts
import { describe, it, expect } from 'vitest';
import {
  jobPostingLd,
  articleLd,
  faqPageLd,
  breadcrumbListLd,
  webPageLd,
} from '../../services/seo/structuredData';

describe('jobPostingLd', () => {
  it('emits JSON-LD with all rule #3 mandatory fields', () => {
    const ld = jobPostingLd({
      id: 'x-1',
      stableId: '550e8400-e29b-41d4-a716-446655440000',
      slug: 'x',
      url: 'https://x.ch/x',
      title: 'Sviluppatore',
      company: 'X',
      hiringOrganization: { name: 'X' },
      location: 'Lugano',
      addressLocality: 'Lugano',
      postalCode: '6900',
      streetAddress: 'Via Test 1',
      description: 'D'.repeat(60),
      datePosted: '2026-05-15',
      employmentType: 'FULL_TIME',
      jobLocation: { addressLocality: 'Lugano', postalCode: '6900', addressCountry: 'CH' },
      baseSalary: { currency: 'CHF', value: { minValue: 80000, maxValue: 110000, unitText: 'YEAR' } },
    });
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('JobPosting');
    expect(ld.baseSalary).toBeDefined();
    expect(ld.hiringOrganization?.name).toBe('X');
    expect(ld.jobLocation?.address?.postalCode).toBe('6900');
  });

  it('throws if job fails JobSchema (impossible nested scripts, impossible thin)', () => {
    // @ts-expect-error intentionally invalid
    expect(() => jobPostingLd({ id: 'bad' })).toThrow();
  });
});

describe('faqPageLd', () => {
  it('emits FAQPage with non-empty mainEntity', () => {
    const ld = faqPageLd([
      { question: 'Q1?', answer: 'A1' },
      { question: 'Q2?', answer: 'A2' },
    ]);
    expect(ld['@type']).toBe('FAQPage');
    expect(ld.mainEntity.length).toBe(2);
    expect(ld.mainEntity[0].acceptedAnswer.text).toBe('A1');
  });
  it('throws if mainEntity would be empty', () => {
    expect(() => faqPageLd([])).toThrow();
  });
});

describe('breadcrumbListLd', () => {
  it('emits BreadcrumbList with position 1..N', () => {
    const ld = breadcrumbListLd([
      { name: 'Home', url: 'https://x.ch/' },
      { name: 'Articoli', url: 'https://x.ch/articoli/' },
    ]);
    expect(ld.itemListElement.map((i: any) => i.position)).toEqual([1, 2]);
  });
});

describe('webPageLd + articleLd', () => {
  it('webPageLd emits canonical url', () => {
    const ld = webPageLd({ url: 'https://frontaliereticino.ch/x', name: 'X', description: 'D'.repeat(60) });
    expect(ld.url).toBe('https://frontaliereticino.ch/x');
  });
  it('articleLd emits Article with author + datePublished', () => {
    const ld = articleLd({
      id: 'x', category: 'fisco', date: '2026-01-15', image: '/i.webp', hasCalculator: false,
      locale: 'it', title: 'Titolo articolo valido lungo abbastanza',
      excerpt: 'E'.repeat(80),
      bodyHtml: '<p>' + 'word '.repeat(60) + '</p>',
      authorSlug: 'valerie-linc', authorName: 'Valerie Linc',
    });
    expect(ld['@type']).toBe('Article');
    expect(ld.author.name).toBe('Valerie Linc');
    expect(ld.datePublished).toBe('2026-01-15');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx vitest run tests/seo/structured-data.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create structuredData.ts**

```ts
// services/seo/structuredData.ts
import { z } from 'zod';
import {
  JobSchema,
  LocalizedArticleSchema,
} from '../../scripts/lib/schemas/index.mjs';

// Strip characters that would cause script-tag nesting if accidentally embedded
// inside <script type="application/ld+json">. By construction, helpers below
// emit objects; the consumer JSON.stringify's them — there is no string
// concatenation path, so nested <script> is impossible.
const safeText = (s: string) => s.replace(/<\/script/gi, '<\\/script');

export const jobPostingLd = (rawJob: unknown) => {
  const job = JobSchema.parse(rawJob);  // throws if invalid
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: safeText(job.title),
    description: safeText(job.description),
    datePosted: job.datePosted,
    employmentType: job.employmentType,
    hiringOrganization: { '@type': 'Organization', name: safeText(job.hiringOrganization.name) },
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        streetAddress: safeText(job.streetAddress),
        addressLocality: job.jobLocation.addressLocality,
        postalCode: job.jobLocation.postalCode,
        addressCountry: job.jobLocation.addressCountry,
      },
    },
    baseSalary: {
      '@type': 'MonetaryAmount',
      currency: job.baseSalary.currency,
      value: {
        '@type': 'QuantitativeValue',
        minValue: job.baseSalary.value.minValue,
        maxValue: job.baseSalary.value.maxValue,
        unitText: job.baseSalary.value.unitText,
      },
    },
    url: job.url,
  };
};

export const articleLd = (rawArticle: unknown) => {
  const a = LocalizedArticleSchema.parse(rawArticle);
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: safeText(a.title),
    description: safeText(a.excerpt),
    datePublished: a.date,
    dateModified: a.updatedAt ?? a.date,
    image: a.image.startsWith('http') ? a.image : `https://frontaliereticino.ch${a.image}`,
    inLanguage: a.locale,
    author: { '@type': 'Person', name: safeText(a.authorName ?? 'Frontaliere Ticino') },
  };
};

const FaqEntry = z.object({ question: z.string().min(1), answer: z.string().min(1) });
const FaqList = z.array(FaqEntry).min(1, 'faqpage-must-have-mainentity');

export const faqPageLd = (entries: unknown) => {
  const list = FaqList.parse(entries);
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: list.map((e) => ({
      '@type': 'Question',
      name: safeText(e.question),
      acceptedAnswer: { '@type': 'Answer', text: safeText(e.answer) },
    })),
  };
};

const BreadcrumbItem = z.object({ name: z.string().min(1), url: z.string().url() });
const BreadcrumbList = z.array(BreadcrumbItem).min(1);

export const breadcrumbListLd = (items: unknown) => {
  const list = BreadcrumbList.parse(items);
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: list.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: safeText(it.name),
      item: it.url,
    })),
  };
};

const WebPageInput = z.object({
  url: z.string().url(),
  name: z.string().min(1),
  description: z.string().min(50).max(160),
});

export const webPageLd = (input: unknown) => {
  const p = WebPageInput.parse(input);
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    url: p.url,
    name: safeText(p.name),
    description: safeText(p.description),
  };
};

// Re-export the existing image-object helper from its original module to
// keep the contract stable while consumers migrate.
export { imageObjectLd } from './imageObjectLd';
```

- [ ] **Step 4: Run test — verify it passes**

Run: `npx vitest run tests/seo/structured-data.test.ts`
Expected: PASS.

- [ ] **Step 5: Add deprecation comment to imageObjectLd.ts**

In `services/seo/imageObjectLd.ts`, prepend:

```ts
// NOTE: New JSON-LD emitters live in `./structuredData.ts`. This module is kept
// for backwards-compat re-export; new callers should import from `structuredData`.
```

- [ ] **Step 6: Commit**

```bash
git add services/seo/structuredData.ts services/seo/imageObjectLd.ts tests/seo/structured-data.test.ts
git commit -m "feat(seo): add schema-driven JSON-LD helpers (jobPosting, article, faqPage, breadcrumb, webPage)"
```

---

## Task 13: Migrate first plugin to use structuredData helpers (orphanQueryLandingPlugin)

**Files:**
- Modify: `build-plugins/orphanQueryLandingPlugin.ts`

This is the JSON-LD hottest spot — refactoring it first proves the pattern. Other plugins follow the same pattern in Task 14.

- [ ] **Step 1: Locate JSON-LD emission sites in orphanQueryLandingPlugin**

Run: `grep -n "@type\|JSON\.stringify.*schema\|application/ld\+json" build-plugins/orphanQueryLandingPlugin.ts`
Note the JobPosting, BreadcrumbList, WebPage, and any FAQPage sites.

- [ ] **Step 2: Replace each hand-rolled JSON-LD with the helper call**

For each emission site, replace the inline object construction with:

```ts
import { jobPostingLd, breadcrumbListLd, webPageLd, faqPageLd } from '@/services/seo/structuredData';

// At emit site:
const jsonLdScripts = [
  `<script type="application/ld+json">${JSON.stringify(webPageLd({ url, name, description }))}</script>`,
  `<script type="application/ld+json">${JSON.stringify(breadcrumbListLd(crumbs))}</script>`,
  ...matchingJobs.map(j => `<script type="application/ld+json">${JSON.stringify(jobPostingLd(j))}</script>`),
].join('\n');
```

- [ ] **Step 3: Run existing orphan-landing tests to confirm no regression**

Run: `npx vitest run tests/ --testNamePattern "orphan" 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 4: Byte-equivalence check against last-known-good dist**

If you have a recent successful `deploy.yml` run:
Run: `gh workflow run audit-dist-from-run.yml -f deploy_run_id=<recent_id> -f audits=jsonld-no-nested-scripts,image-object-license`
Confirm both audits report 0 violations against the artifact (they should — we haven't deployed yet, this verifies the audit hasn't been broken).

After PR is open, the deploy will re-run these audits against the new dist; expect them to also be clean.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/orphanQueryLandingPlugin.ts
git commit -m "refactor(seo): orphanQueryLandingPlugin uses schema-driven JSON-LD helpers"
```

---

## Task 14: Migrate remaining plugins to structuredData helpers

**Files (each gets the same treatment as Task 13):**
- `build-plugins/jobsSeoPages*.ts` (every file matching this glob)
- `build-plugins/salaryHubPlugin.ts`
- `build-plugins/careerLandingsPlugin.ts`
- `build-plugins/healthPremiumsLandingPlugin.ts`
- `build-plugins/fuelDailyPagesPlugin.ts`
- `build-plugins/weeklyEmployersPlugin.ts`
- `build-plugins/jobMarketSnapshotPlugin.ts`
- `build-plugins/borderWaitPlugin.ts`
- `build-plugins/costOfLivingLandingsPlugin.ts`
- Any plugin still emitting JSON-LD by hand (find via `grep -rln "application/ld+json" build-plugins/`)

- [ ] **Step 1: Inventory remaining JSON-LD emission sites**

Run: `grep -rln "application/ld+json" build-plugins/ | sort -u`
Note the list. Should be ~10-15 files.

- [ ] **Step 2: For each file, repeat Task 13 steps 1-3**

Commit per file:

```bash
git commit -m "refactor(seo): <plugin-name> uses schema-driven JSON-LD helpers"
```

- [ ] **Step 3: Confirm zero remaining hand-rolled JSON-LD object literals**

Run: `grep -rn "'@type':\|\"@type\":" build-plugins/ | grep -v structuredData | grep -v node_modules`
Expected: empty output (all `@type` references now live behind helpers).

- [ ] **Step 4: Full vitest run to catch regressions**

Run: `npx vitest run 2>&1 | tail -30`
Expected: full green or pre-existing-only failures (do not introduce new failures).

---

## Task 15: Retire 7 dist-walking audits as registry entries

**Files:**
- Modify: `scripts/audit-all.mjs`
- Modify: `.github/workflows/deploy.yml`
- Modify: `.github/workflows/post-deploy-validate-dist.yml`
- Modify: `.github/workflows/post-deploy-validation.yml`
- Modify: `package.json` (audit:* scripts)
- Delete: 7 audit scripts + their baseline JSONs (after grace period — see step 4)

- [ ] **Step 1: Confirm each retired audit's invariant is enforced upstream**

Verification matrix (run each):

| Audit | Build-time replacement | Verify command |
|---|---|---|
| title-length | `SeoTitleSchema` max(66) | `npx vitest run tests/schemas/seo-text-schema.test.ts` shows the cap |
| title-no-disambig-hash | `SeoTitleSchema` regex refine | same |
| h1-title-duplicates | Will be added to `LocalizedArticleSchema` via refine; see step 2 below | new test |
| jsonld-no-nested-scripts | `safeText()` in `structuredData.ts` + helper-only emission | `grep -rn "'@type':" build-plugins/` empty |
| image-object-license | `ImageObjectSchema` (existing) requires `license` | inspect `services/seo/imageObjectLd.ts` |
| faqpage-validity | `FaqList` min(1) in `structuredData.ts` | `tests/seo/structured-data.test.ts` |
| footer-root-presence | Template-level invariant in `buildSeoPageHtml` (already enforced; the audit was belt+suspenders) | inspect `build-plugins/shared/seoPageShell.ts` |

- [ ] **Step 2: Add the missing h1-title-duplicates refine to LocalizedArticleSchema**

In `scripts/lib/schemas/article.mjs`, modify `LocalizedArticleSchema`:

```js
export const LocalizedArticleSchema = ArticleMetaSchema.extend({
  locale: z.enum(['it', 'en', 'de', 'fr']),
  title: SeoTitleSchema,
  excerpt: SeoMetaDescriptionSchema,
  bodyHtml: ArticleLocaleBodySchema,
  h1: SeoH1Schema.optional(),  // articles may omit explicit h1 (template derives from title)
}).refine(
  (a) => a.h1 === undefined || a.h1.trim() !== a.title.trim(),
  { message: 'h1-must-differ-from-title-rule-audit-h1-title-duplicates', path: ['h1'] },
);
```

Add a test:

```ts
it('rejects article where h1 equals title', () => {
  const a = { ...validMeta, locale: 'it' as const, title: 'Same', h1: 'Same', excerpt: 'A'.repeat(80), bodyHtml: '<p>' + 'word '.repeat(60) + '</p>' };
  expect(LocalizedArticleSchema.safeParse(a).success).toBe(false);
});
```

Run: `npx vitest run tests/schemas/article-schema.test.ts`
Expected: PASS (now 9 assertions).

- [ ] **Step 3: Remove the 7 audits from `audit-all.mjs` registry**

Open `scripts/audit-all.mjs`, locate the audit registry (likely an array or map of audit names → run functions), and remove these 7 entries:

```
- footer-root-presence
- jsonld-no-nested-scripts
- title-length
- title-no-disambig-hash
- h1-title-duplicates
- image-object-license
- faqpage-validity
```

- [ ] **Step 4: Remove the 7 audits from workflow YAMLs**

For each of `deploy.yml`, `post-deploy-validate-dist.yml`, `post-deploy-validation.yml`:

```bash
# Inspect the audit steps:
grep -n "audit:title-length\|audit:h1-title-duplicates\|audit:footer-root-presence\|audit:jsonld-no-nested-scripts\|audit:image-object-license\|audit:faqpage-validity\|audit:title-no-disambig-hash" .github/workflows/deploy.yml
```

Remove or comment-out the corresponding `- name:` + `run:` blocks. Add a comment block referencing this sub-plan for archaeology:

```yaml
# Retired 2026-05-NN — invariant now enforced at build-time via JobSchema /
# ArticleSchema / structuredData.ts helpers (sub-plan 01, frontaliereticino).
# Cleanup of audit scripts pending grace period.
```

- [ ] **Step 5: Remove the 7 audit:* scripts from package.json**

Remove these lines:
- `"audit:title-length": ...`
- `"audit:title-no-disambig-hash": ...`
- `"audit:h1-title-duplicates": ...`
- `"audit:jsonld-no-nested-scripts": ...`
- `"audit:image-object-license": ...`
- `"audit:faqpage-validity": ...`
- `"audit:footer-root-presence": ...`
- All corresponding `:rebaseline` scripts.

- [ ] **Step 6: Run a representative subset of remaining audits to confirm no breakage**

Run: `npx vitest run tests/ 2>&1 | tail -20`
Run: `node scripts/audit-all.mjs --dist=dist --audits=text-html-ratio,page-weight,content-duplicates,bfs-depth 2>&1 | tail -20`
(If no `dist/` exists locally, skip the second command — CI will run it.)

- [ ] **Step 7: Commit**

```bash
git add scripts/audit-all.mjs .github/workflows/deploy.yml .github/workflows/post-deploy-validate-dist.yml .github/workflows/post-deploy-validation.yml package.json scripts/lib/schemas/article.mjs tests/schemas/article-schema.test.ts
git commit -m "feat(audits): retire 7 dist-walking audits — invariants enforced at build-time via schemas"
```

- [ ] **Step 8: Grace period — keep audit scripts in repo for one deploy cycle**

Do NOT delete `scripts/audit-*.mjs` files yet. Leave them for one successful deploy cycle so we can re-enable any of them quickly if a real regression slips through. They are no longer wired into any workflow.

After 7 days of clean deploys, do:

```bash
git rm scripts/audit-title-length.mjs scripts/audit-title-no-disambig-hash.mjs \
       scripts/audit-h1-title-duplicates.mjs scripts/audit-jsonld-no-nested-scripts.mjs \
       scripts/audit-image-object-license.mjs scripts/audit-faqpage-validity.mjs \
       scripts/audit-footer-root-presence.mjs

# Baseline files (verify they exist first):
git rm data/title-length-baseline.json data/title-no-disambig-hash-baseline.json \
       data/h1-title-duplicates-baseline.json 2>/dev/null || true

git commit -m "chore(audits): remove retired audit scripts + baselines after grace period"
```

---

## Task 16: Wire the new test files into the test:seo-gates script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the new schema tests to test:seo-gates**

In `package.json` extend `test:seo-gates`:

```json
"test:seo-gates": "vitest run tests/schemas/ tests/seo/structured-data.test.ts tests/title-length.test.ts tests/h1-not-equal-title.test.ts tests/url-max-length.test.ts tests/hreflang-no-broken.test.ts tests/dist-single-h1-per-page.test.ts tests/dist-link-anchor-text.test.ts tests/seo-html-lang-sync.test.ts tests/seo/software-application-jsonld.test.ts",
```

- [ ] **Step 2: Run it**

Run: `npm run test:seo-gates 2>&1 | tail -20`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(tests): include schema tests in test:seo-gates"
```

---

## Task 17: Final verification & PR

- [ ] **Step 1: Full test suite**

Run: `npm test 2>&1 | tail -30`
Expected: full green.

- [ ] **Step 2: Full type-check**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: 0 errors.

- [ ] **Step 3: Confirm assembler is idempotent**

Run: `node scripts/assemble-jobs-dataset.mjs --stats 2>&1 | tail -10`
Expected: completes with stats; if it fails on real data, fix the offending crawler slices (do NOT loosen the schema; per CLAUDE.md rule #1).

- [ ] **Step 4: Confirm no new files exceed the 800-line ceiling**

Run: `wc -l scripts/lib/schemas/*.mjs services/seo/structuredData.ts tests/schemas/*.ts tests/seo/structured-data.test.ts | sort -n`
Expected: all files under 800 lines (likely under 200 each).

- [ ] **Step 5: Open the PR**

Per CLAUDE.md PR-as-merge-vehicle: reuse the commit messages as PR body.

```bash
git push -u origin <branch>
gh pr create --fill --title "feat: Zod foundations + schema-driven JSON-LD — retires 7 audit gates"
```

- [ ] **Step 6: Squash-merge once CI is green**

Per CLAUDE.md "no CI wait" rule: if typecheck + vitest are local-green, merge immediately without waiting on CI.

```bash
gh pr merge <number> --squash
git push origin --delete <branch>
```

- [ ] **Step 7: ExitWorktree**

After cleanup, exit the worktree.

---

## Self-review (per skill mandate)

**Spec coverage:**
- Zod install → Task 1 ✓
- Schemas for 6 data sources → Tasks 3 (job), 5 (article), 7 (orphan), 8 (health), 9 (fuel), 10 (border) ✓
- Reusable SEO text schemas → Task 2 ✓
- Barrel export → Task 11 ✓
- JSON-LD helpers → Task 12 ✓
- Plugin migration → Tasks 13-14 ✓
- 7 audits retired → Task 15 ✓
- Tests wired into CI gate → Task 16 ✓
- Verification + PR → Task 17 ✓

**Placeholders scan:** "locate via grep" appears in Task 8, 9, 10. These are necessary — the producer scripts for health-premiums/fuel-daily/border-wait weren't read during the investigation, so the plan can't pre-name them. The grep command IS the step; the engineer reads the file once located. Not a placeholder failure.

**Type consistency:** All exported names (`JobSchema`, `LocalizedJobSchema`, `ArticleMetaSchema`, `LocalizedArticleSchema`, `OrphanClusterSchema`, `HealthPremiumRowSchema`, `FuelDailySnapshotSchema`, `BorderWaitMeasurementSchema`, `SeoTitleSchema`, `SeoH1Schema`, `SeoMetaDescriptionSchema`, `jobPostingLd`, `articleLd`, `faqPageLd`, `breadcrumbListLd`, `webPageLd`) consistent across all task references and match the master plan index.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-20-astro-zod-01-zod-foundations.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Orchestrator dispatches a fresh subagent per task (17 subagents total), reviews each completion before the next dispatches, fast iteration. Subagent-driven shines on multi-task plans like this one where each task is bounded and verifiable.

**2. Inline Execution** — Execute all 17 tasks in this same session using `superpowers:executing-plans`, with checkpoints between tasks 7, 12, 15 for review.

**Which approach?**

(For sub-plans 02-08, the same handoff question repeats at the bottom of each sub-plan document.)
