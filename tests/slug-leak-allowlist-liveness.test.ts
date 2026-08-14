/**
 * The allowlist may not outlive the defect it excuses (issue #5510, item 1).
 *
 * `KNOWN_LEGACY_LEAKS` in `scripts/audit-slug-prompt-leaks.mjs` is a list of
 * slugs that leak the prompt template and are accepted anyway, because they
 * were already published when the detector learned to see them. Every guard in
 * this repo points the same way — a NEW leak fails. Nothing pointed the other
 * way, and that is the gap this file closes.
 *
 * ── WHY THE OTHER DIRECTION IS THE ONE THAT ROTS ─────────────────────────
 *
 * An allowlist entry is a claim about production: "this slug is out there,
 * dirty, and we are living with it". Once the slug is repaired the claim is
 * false, and a false exclusion is not inert — it stays armed over a STRING,
 * and the next article that lands on that string inherits the excuse. The
 * audit would print `✅` at it.
 *
 * Measured on origin/main, 2026-08-14: of the seventeen entries the list
 * carried, fifteen still matched a slug in the two registries and two did
 * not. `slug-gaggiolo-traffic` and `slug-gaggiolo-verkehr` had been repaired
 * upstream — `routerBlogData.ts` now reads `en: 'gaggiolo-traffic', de:
 * 'gaggiolo-verkehr'`, and the old URLs answer 301 to the clean ones — and the
 * list had gone on excusing them with nothing anywhere reporting it. Not one
 * check in the repo could have told you: `audit-slug-prompt-leaks.mjs` only
 * counted leaks NOT in the list, and the vitest sweep next door
 * (`article-slug-prompt-leak-guard.test.ts`) asserted liveness for the four
 * `kebab-case-*` slugs of family 1 only — hardcoded, so families 2 and 3 were
 * outside it by construction.
 *
 * ── WHAT THIS FILE IS AND IS NOT ─────────────────────────────────────────
 *
 * It asserts the audit's own `findDeadAllowlistEntries`, not a second copy of
 * the idea: a test that re-implements what it checks agrees with itself and
 * proves nothing. And it is structural — it matches slugs through the audit's
 * extractors, never a byte offset into a source file. A window like
 * `slice(i, i + 40)` over a registry goes red the day someone adds a comment,
 * and a guard that cries at comments gets deleted within the week.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AUDIT_SOURCES,
  KNOWN_LEGACY_LEAKS,
  extractRegistrySlugs,
  extractSitemapSlugs,
  findDeadAllowlistEntries,
} from '../scripts/audit-slug-prompt-leaks.mjs';
import { findSlugPromptLeak } from '../scripts/lib/slug-prompt-leak-guard.mjs';

const ROOT = resolve(__dirname, '..');

/** The audit's own scan, reproduced through its own exports. */
function scanSources() {
  const scanned: { path: string; kind: string; slugs: number }[] = [];
  const leaked = new Set<string>();

  for (const { path: rel, kind } of AUDIT_SOURCES) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, 'utf8');
    const slugs = kind === 'registry' ? extractRegistrySlugs(src) : extractSitemapSlugs(src);
    scanned.push({ path: rel, kind, slugs: slugs.length });
    for (const slug of slugs) if (findSlugPromptLeak(slug)) leaked.add(slug);
  }
  return { scanned, leaked };
}

describe('KNOWN_LEGACY_LEAKS carries no dead entry', () => {
  const { scanned, leaked } = scanSources();

  it('reads both article registries, or refuses to judge (fail-closed)', () => {
    // `public/` is git-tracked but absent from a sparse worktree, so the
    // sitemaps may legitimately be missing here and present in CI. The
    // registries never are. An unread file must never be mistaken for a file
    // with nothing in it — that is the exact shape of the bug behind #5510.
    expect(scanned.filter((s) => s.kind === 'registry').map((s) => s.path).sort()).toEqual([
      'packages/articles/content/routerBlogData.ts',
      'packages/articles/content/routerSwissData.ts',
    ]);
    expect(findDeadAllowlistEntries(leaked, scanned).enforceable).toBe(true);
  });

  it('every entry still matches a leaking slug in a scanned source', () => {
    const { dead } = findDeadAllowlistEntries(leaked, scanned);
    expect(
      dead.sort(),
      'These slugs are in KNOWN_LEGACY_LEAKS but no source still contains them. ' +
        'That means they were REPAIRED, which is good news and still a failure: ' +
        'the entry now shields any future slug with the same name. ' +
        'Remedy: delete those lines from scripts/audit-slug-prompt-leaks.mjs. ' +
        'Do not silence this by widening the detector.',
    ).toEqual([]);
  });

  it('the list is not empty, so the assertion above cannot pass vacuously', () => {
    // An empty allowlist satisfies "no dead entries" trivially. If the day
    // comes that the corpus is fully repaired and the list legitimately
    // empties, this line is the one that forces the deletion to be noticed
    // rather than absorbed.
    expect(KNOWN_LEGACY_LEAKS.size).toBeGreaterThan(0);
  });

  it('reports the entries it proved live, as a countable fact', () => {
    const live = [...KNOWN_LEGACY_LEAKS].filter((s) => leaked.has(s));
    expect(live.length).toBe(KNOWN_LEGACY_LEAKS.size);
  });
});

describe('findDeadAllowlistEntries — the verdict logic itself', () => {
  const registries = AUDIT_SOURCES.filter((s) => s.kind === 'registry').map((s) => ({
    path: s.path,
    kind: s.kind,
    slugs: 1,
  }));

  it('convicts an entry that no source contains any more', () => {
    // Every real entry seen except one: that one must come back as dead.
    const [victim, ...rest] = [...KNOWN_LEGACY_LEAKS];
    const { enforceable, dead } = findDeadAllowlistEntries(rest, registries);
    expect(enforceable).toBe(true);
    expect(dead).toEqual([victim]);
  });

  it('acquits when every entry is still seen', () => {
    const { dead } = findDeadAllowlistEntries([...KNOWN_LEGACY_LEAKS], registries);
    expect(dead).toEqual([]);
  });

  it('withholds the verdict when a REGISTRY is unread, instead of guessing', () => {
    // The dangerous direction: an unread registry would make every entry look
    // dead and turn this guard into a demand to erase a real allowlist.
    const { enforceable, dead, reason } = findDeadAllowlistEntries([], registries.slice(0, 1));
    expect(enforceable).toBe(false);
    expect(dead).toEqual([]);
    expect(reason).toMatch(/registry/);
  });

  it('judges on the registries alone, without needing the sitemaps', () => {
    // A slug cannot reach a sitemap without being in a registry first — the
    // sitemaps are generated FROM the registries and
    // scripts/ci/check-blog-slugs-sitemap-sync.mjs enforces that both ways.
    // So a missing sitemap can only ever hide a duplicate sighting, and the
    // verdict stays the same as with everything read.
    const { scanned, leaked } = scanSources();
    const registriesOnly = scanned.filter((s) => s.kind === 'registry');
    expect(findDeadAllowlistEntries(leaked, registriesOnly).dead).toEqual(
      findDeadAllowlistEntries(leaked, scanned).dead,
    );
  });

  it('is insensitive to source formatting — it matches slugs, not offsets', () => {
    // The anti-pattern this file must not become: a byte window into a file.
    // Re-scanning a registry with extra whitespace and comments must not move
    // the verdict, or the guard dies of false alarms.
    const rel = 'packages/articles/content/routerBlogData.ts';
    const src = readFileSync(resolve(ROOT, rel), 'utf8');
    const padded = `// a comment\n\n${src}\n// another comment\n`;
    const before = new Set(extractRegistrySlugs(src).filter((s) => findSlugPromptLeak(s)));
    const after = new Set(extractRegistrySlugs(padded).filter((s) => findSlugPromptLeak(s)));
    expect([...after].sort()).toEqual([...before].sort());
  });
});
