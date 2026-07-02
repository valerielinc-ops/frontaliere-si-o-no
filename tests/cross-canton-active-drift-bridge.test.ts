import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const jobsSeoSrc = fs.readFileSync(
  path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'),
  'utf-8',
);

// Regression guard for the cross-canton ACTIVE-job orphan bug.
//
// A non-TI job that is ALIVE (e.g. a Valais Swiss-Life listing) keeps a legacy
// indexed URL under the Ticino section (/fr/trouver-emploi-tessin/<slug>/). The
// compat-merge OVERWRITES that active job's locale tracking path with this drift
// URL (so the live job is the one served at its real canton page). Before this
// fix the drift URL then fell through to the self-healing pass, which emitted a
// `noindex` "offer removed" tombstone — a soft-404 for a LIVE job, served as a
// bundle-less stub so the SPA-side cross-canton fallback could never recover it.
//
// The fix: stash the job's real (live) canonical path at overwrite time, and in
// the self-healing pass emit a RELOCATION bridge whose canonical + CTA point at
// the live canton page instead of the tombstone.
describe('Cross-canton active-job drift URL → relocation bridge (not orphan)', () => {
  it('stashes the live canonical path only for ACTIVE jobs at compat-merge overwrite', () => {
    // The capture must be gated on currentSlugs (active) — expired jobs already
    // `break` earlier and must NOT be relocated (their native page is gone).
    expect(jobsSeoSrc).toContain('const activeDriftRealPathByCompat = new Map<string, string>();');
    expect(jobsSeoSrc).toMatch(
      /if \(known && currentSlugs\.has\(slug\)\) activeDriftRealPathByCompat\.set\(compatPath, known\);/,
    );
    // Capture must happen BEFORE the tracking value is overwritten with the drift path,
    // so `known` still holds the live canonical path.
    const captureIdx = jobsSeoSrc.indexOf('activeDriftRealPathByCompat.set(compatPath, known)');
    const overwriteIdx = jobsSeoSrc.indexOf('(tracking[slug] as Record<string, string>)[locale] = compatPath;');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(overwriteIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeLessThan(overwriteIdx);
  });

  it('self-healing emits a relocation bridge to the LIVE page for active drift URLs', () => {
    // The self-healing pass must consult the stash by the tracking path...
    expect(jobsSeoSrc).toMatch(/const driftRealPath = activeDriftRealPathByCompat\.get\(relPath\);/);
    // ...and build a canonical bridge whose canonicalUrl is the live page (BASE_URL +
    // the real canton path) — UNLESS the tracking path falls inside the reserved
    // company-hub namespace (issue #2976, 6th call site), in which case canonicalUrl
    // is the Swiss aggregator instead (see cathedral-sector-hubs.test.ts). The CTA
    // (pathLabel) always targets the real page regardless.
    expect(jobsSeoSrc).toMatch(/const namespaceCollision = isCompanyHubNamespaceSlug\(relSlug, locale\);/);
    expect(jobsSeoSrc).toMatch(/const realUrl = namespaceCollision\s*\n?\s*\?[^:]*AGGREGATE_KEY[^:]*\n?\s*:\s*`\$\{BASE_URL\}\$\{withSlash\(driftRealPath\)\}`;/);
    const branchIdx = jobsSeoSrc.indexOf('const driftRealPath = activeDriftRealPathByCompat.get(relPath);');
    const branch = jobsSeoSrc.slice(branchIdx, branchIdx + 2900);
    expect(branch).toContain('canonicalUrl: realUrl');
    expect(branch).toContain('pathLabel: withSlash(driftRealPath)');
    // Must short-circuit before the orphan tombstone below.
    expect(branch).toContain('continue;');
  });

  it('relocation bridge carries a "moved" message in all four locales (not "removed")', () => {
    const branchIdx = jobsSeoSrc.indexOf('const driftRealPath = activeDriftRealPathByCompat.get(relPath);');
    const branch = jobsSeoSrc.slice(branchIdx, branchIdx + 2900);
    // One entry per locale, framed as a relocation rather than a removal.
    expect(branch).toMatch(/it:\s*\{[^}]*Annuncio spostato/);
    expect(branch).toMatch(/en:\s*\{[^}]*Listing moved/);
    expect(branch).toMatch(/de:\s*\{[^}]*Anzeige verschoben/);
    expect(branch).toMatch(/fr:\s*\{[^}]*Offre déplacée/);
  });
});

// Regression guard for issue #3150 (follow-up of #3144): the
// `activeDriftRealPathByCompat` stash above is keyed ONLY by `compatPath`
// (locale-agnostic). That's only safe if COMPAT_JOB_PATTERNS never lets two
// different locales produce the same `prefix` — otherwise the second
// locale's `.set()` silently overwrites the first, and the self-healing
// lookup emits a canonical pointing at the wrong locale's page. This test
// parses the live COMPAT_JOB_PATTERNS table out of the source and enforces
// the invariant so a future pattern addition can't reintroduce the risk.
describe('COMPAT_JOB_PATTERNS prefixes stay locale-unique (compatPath collision guard)', () => {
  const patternsBlockMatch = jobsSeoSrc.match(
    /const COMPAT_JOB_PATTERNS:[^=]*=\s*\[([\s\S]*?)\n\s*\];/,
  );
  if (!patternsBlockMatch) {
    throw new Error('COMPAT_JOB_PATTERNS table not found in jobsSeoPagesPlugin.ts — update this test\'s parser.');
  }
  const patternsBlock = patternsBlockMatch[1];
  const entries = [...patternsBlock.matchAll(/locale:\s*'([^']+)',\s*prefix:\s*'([^']+)'/g)].map(
    ([, locale, prefix]) => ({ locale, prefix }),
  );

  it('parses at least one entry per known locale (parser sanity check)', () => {
    expect(entries.length).toBeGreaterThanOrEqual(4);
    const locales = new Set(entries.map((e) => e.locale));
    expect(locales).toEqual(new Set(['it', 'en', 'de', 'fr']));
  });

  it('never maps the same prefix to two different locales', () => {
    const localeByPrefix = new Map<string, string>();
    for (const { locale, prefix } of entries) {
      const existing = localeByPrefix.get(prefix);
      if (existing !== undefined) {
        expect(existing).toBe(locale); // same prefix must always mean same locale
      } else {
        localeByPrefix.set(prefix, locale);
      }
    }
  });

  it('never has a different-locale prefix that is a string-prefix of another (would let slugs alias across locales)', () => {
    const distinctPrefixLocales = [
      ...new Map(entries.map((e) => [e.prefix, e.locale])).entries(),
    ];
    for (const [prefixA, localeA] of distinctPrefixLocales) {
      for (const [prefixB, localeB] of distinctPrefixLocales) {
        if (prefixA === prefixB) continue;
        if (localeA === localeB) continue; // same-locale overlap is not a cross-locale risk
        expect(prefixB.startsWith(prefixA)).toBe(false);
      }
    }
  });
});
