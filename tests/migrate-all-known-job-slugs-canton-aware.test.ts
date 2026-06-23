/**
 * Explicit verification that migrate-all-known-job-slugs-canton-aware.mjs treats
 * the jobs.json slug as canonical and ONLY rewrites the canton SECTION prefix —
 * it never re-derives or mutates the slug body itself. This is the assumption
 * the upstream slug-stabilization relies on; here it is asserted end-to-end.
 *
 * The script resolves data/* against process.cwd(), so it is exercised by
 * running it with cwd set to a temp fixtures dir (real canton reference data is
 * copied in; jobs + tracking are minimal fixtures). No source changes needed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repoRoot, 'scripts', 'migrate-all-known-job-slugs-canton-aware.mjs');

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

describe('migrate-all-known-job-slugs-canton-aware', () => {
  it('rewrites only the canton section prefix and preserves the slug body', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-canton-'));
    tmpDirs.push(tmp);
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);

    // Real canton reference data (the script mirrors cantonSection.ts from it).
    fs.copyFileSync(path.join(repoRoot, 'data', 'canton-url-slugs.json'), path.join(dataDir, 'canton-url-slugs.json'));
    fs.copyFileSync(path.join(repoRoot, 'data', 'canton-municipalities.json'), path.join(dataDir, 'canton-municipalities.json'));

    const SLUG = 'software-engineer-acme-zurich';
    // One ZH (non-TI) job — its tracking path should migrate TI→ZH section.
    fs.writeFileSync(path.join(dataDir, 'jobs.json'), JSON.stringify([
      { id: 'j1', slug: SLUG, canton: 'ZH', location: 'Zürich', slugByLocale: { it: SLUG, en: SLUG, de: SLUG, fr: SLUG } },
    ]));
    // Tracking entry currently under the legacy TI section, per locale.
    fs.writeFileSync(path.join(dataDir, 'all-known-job-slugs.json'), JSON.stringify({
      [SLUG]: {
        it: `/cerca-lavoro-ticino/${SLUG}/`,
        en: `/en/find-jobs-ticino/${SLUG}/`,
        de: `/de/jobs-im-tessin/${SLUG}/`,
        fr: `/fr/trouver-emploi-tessin/${SLUG}/`,
        source: 'gsc-404-import',
      },
    }));

    execFileSync('node', [SCRIPT], { cwd: tmp, stdio: 'pipe' });

    const out = JSON.parse(fs.readFileSync(path.join(dataDir, 'all-known-job-slugs.json'), 'utf-8'));
    const entry = out[SLUG];

    // Section prefix migrated TI → ZH. Derive the expected ZH it-slug from the
    // loaded fixture rather than hardcoding it, so the assertion tracks the
    // reference data instead of aging against it.
    const cantonSlugs = JSON.parse(fs.readFileSync(path.join(dataDir, 'canton-url-slugs.json'), 'utf-8'));
    const zhItSlug = cantonSlugs.cantons.ZH.it;
    expect(entry.it).toBe(`/cerca-lavoro-${zhItSlug}/${SLUG}/`);
    expect(entry.it).not.toContain('cerca-lavoro-ticino');
    expect(entry.en).toContain('/find-jobs-');
    expect(entry.en).not.toContain('find-jobs-ticino');

    // Slug body preserved verbatim in every locale path (never re-derived).
    for (const loc of ['it', 'en', 'de', 'fr'] as const) {
      expect(entry[loc].endsWith(`/${SLUG}/`)).toBe(true);
    }
    // Non-locale metadata preserved.
    expect(entry.source).toBe('gsc-404-import');
  });

  it('reconciles a stale NON-TI section to the job current canton (ZH→BE drift)', () => {
    // The old migration only rewrote TI-prefixed paths, so a job that migrated
    // between non-TI cantons kept its first non-TI section forever → recovery
    // 301'd the orphan to a dead canton. The fix reconciles every section.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-canton-drift-'));
    tmpDirs.push(tmp);
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);
    fs.copyFileSync(path.join(repoRoot, 'data', 'canton-url-slugs.json'), path.join(dataDir, 'canton-url-slugs.json'));
    fs.copyFileSync(path.join(repoRoot, 'data', 'canton-municipalities.json'), path.join(dataDir, 'canton-municipalities.json'));

    const cantonSlugs = JSON.parse(fs.readFileSync(path.join(dataDir, 'canton-url-slugs.json'), 'utf-8'));
    const zhItSlug = cantonSlugs.cantons.ZH.it;
    const beItSlug = cantonSlugs.cantons.BE.it;
    const SLUG = 'projektleiter-acme-bern';

    // Job is now in BE, but its ledger entry is stale on the ZH section.
    fs.writeFileSync(path.join(dataDir, 'jobs.json'), JSON.stringify([
      { id: 'j3', slug: SLUG, canton: 'BE', location: 'Bern', slugByLocale: { it: SLUG, en: SLUG, de: SLUG, fr: SLUG } },
    ]));
    fs.writeFileSync(path.join(dataDir, 'all-known-job-slugs.json'), JSON.stringify({
      [SLUG]: {
        it: `/cerca-lavoro-${zhItSlug}/${SLUG}/`,
        en: `/en/find-jobs-zurich/${SLUG}/`,
        de: `/de/jobs-in-zurich/${SLUG}/`,
        fr: `/fr/trouver-emploi-zurich/${SLUG}/`,
      },
    }));

    execFileSync('node', [SCRIPT], { cwd: tmp, stdio: 'pipe' });

    const out = JSON.parse(fs.readFileSync(path.join(dataDir, 'all-known-job-slugs.json'), 'utf-8'));
    const entry = out[SLUG];
    expect(entry.it).toBe(`/cerca-lavoro-${beItSlug}/${SLUG}/`);
    expect(entry.it).not.toContain(`cerca-lavoro-${zhItSlug}`);
    // Slug body preserved verbatim across all locales.
    for (const loc of ['it', 'en', 'de', 'fr'] as const) {
      expect(entry[loc].endsWith(`/${SLUG}/`)).toBe(true);
    }
  });

  it('leaves a non-section first segment untouched instead of clobbering it', () => {
    // Guard against first-segment clobber: if a ledger entry's first segment is
    // NOT a section the resolver emits (hand-edited / non-section path), the
    // migration must leave it verbatim rather than rewrite it toward a canton
    // section that would 301 to a page that was never emitted.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-canton-nonsection-'));
    tmpDirs.push(tmp);
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);
    fs.copyFileSync(path.join(repoRoot, 'data', 'canton-url-slugs.json'), path.join(dataDir, 'canton-url-slugs.json'));
    fs.copyFileSync(path.join(repoRoot, 'data', 'canton-municipalities.json'), path.join(dataDir, 'canton-municipalities.json'));

    const SLUG = 'data-analyst-acme-zurich';
    // Job resolves to ZH, but the ledger path is under a non-section segment.
    fs.writeFileSync(path.join(dataDir, 'jobs.json'), JSON.stringify([
      { id: 'j4', slug: SLUG, canton: 'ZH', location: 'Zürich', slugByLocale: { it: SLUG, en: SLUG } },
    ]));
    const original = {
      [SLUG]: {
        it: `/chi-siamo/${SLUG}/`, // non-section first segment — must be left as-is
        en: `/en/find-jobs-ticino/${SLUG}/`, // valid TI section — must reconcile to ZH
      },
    };
    fs.writeFileSync(path.join(dataDir, 'all-known-job-slugs.json'), JSON.stringify(original));

    execFileSync('node', [SCRIPT], { cwd: tmp, stdio: 'pipe' });

    const out = JSON.parse(fs.readFileSync(path.join(dataDir, 'all-known-job-slugs.json'), 'utf-8'));
    const entry = out[SLUG];
    // Non-section path preserved verbatim (NOT clobbered to /cerca-lavoro-…/).
    expect(entry.it).toBe(`/chi-siamo/${SLUG}/`);
    // The genuine section path is still reconciled in the same entry.
    expect(entry.en).toContain('/find-jobs-');
    expect(entry.en).not.toContain('find-jobs-ticino');
  });

  it('leaves TI jobs untouched (invariance)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-canton-ti-'));
    tmpDirs.push(tmp);
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);
    fs.copyFileSync(path.join(repoRoot, 'data', 'canton-url-slugs.json'), path.join(dataDir, 'canton-url-slugs.json'));
    fs.copyFileSync(path.join(repoRoot, 'data', 'canton-municipalities.json'), path.join(dataDir, 'canton-municipalities.json'));

    const SLUG = 'cuoco-ristorante-lugano';
    fs.writeFileSync(path.join(dataDir, 'jobs.json'), JSON.stringify([
      { id: 'j2', slug: SLUG, canton: 'TI', location: 'Lugano', slugByLocale: { it: SLUG } },
    ]));
    const original = { [SLUG]: { it: `/cerca-lavoro-ticino/${SLUG}/` } };
    fs.writeFileSync(path.join(dataDir, 'all-known-job-slugs.json'), JSON.stringify(original));

    execFileSync('node', [SCRIPT], { cwd: tmp, stdio: 'pipe' });

    const out = JSON.parse(fs.readFileSync(path.join(dataDir, 'all-known-job-slugs.json'), 'utf-8'));
    expect(out[SLUG].it).toBe(`/cerca-lavoro-ticino/${SLUG}/`);
  });
});
