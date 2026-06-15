/**
 * Regression guard: no build-plugin (and no App.tsx) may emit an internal
 * `?q=` / `&q=` outlink.
 *
 * robots.txt disallows `/*?q=*` and `/*&q=*`, so an internal `<a>` pointing at
 * such a keyword-search URL is a "disallowed outlink" (flagged by SearchAtlas /
 * GSC). `rel="nofollow"` is NOT an escape hatch — it is banned on internal
 * links by `tests/no-internal-nofollow.test.tsx`. Every chip must route to a
 * crawlable target instead:
 *   - sector chips → per-canton sector landing where one exists, else the
 *     canton / TI job-board root (`seoHubsPlugin`, App.tsx footer);
 *   - employer / role chips → the curated brand/sector hub where one exists,
 *     else the job-board root (`weeklyEmployersPlugin`, `jobMarketSnapshotPlugin`,
 *     `nursing/career/costOfLiving/professionLandingsPlugin`).
 *
 * A disallowed outlink is emitted dynamically in one of two forms, both matched
 * here:
 *   1. template-literal interpolation — `?q=${…}` / `&q=${…}`;
 *   2. string-concat — `'?q=' + …` / `"&q=" + …` / `` `?q=` + … `` (a string or
 *      template literal closed right after `q=`, then concatenated).
 * Matching both pre-empts a reintroduction via the alternate (concat) form
 * slipping past a template-literal-only guard.
 *
 * `?q=` tokens inside explanatory comments, external ATS URLs (literal `?q=&…`),
 * and the JSON-LD SearchAction template (`?q={search_term_string}`) stay inert:
 * none is followed by `${` or by a closing quote/backtick then `+`.
 *
 * Scope is the whole `build-plugins/` tree (walked recursively) plus the
 * `App.tsx` footer — i.e. every known chip emitter, not just `seoHubsPlugin.ts`.
 * The footer (App.tsx) is additionally covered behaviourally by
 * `tests/regression/footer-canton-scoped-seo-hubs.test.tsx`, whose assertions
 * inspect rendered hrefs and so catch any construction form.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
// 1. `?q=${…}` (template-literal interpolation); 2. `'?q=' +` / `"&q=" +` /
// `` `?q=` + `` (string-concat). See file header for why literals/comments stay inert.
const Q_EMIT_RX = /[?&]q=(?:\$\{|['"`]\s*\+)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('no build-plugin emits a robots-disallowed ?q= outlink', () => {
  it('no `?q=`/`&q=` outlink (interpolated or string-concat) in build-plugins/ or App.tsx', () => {
    const files = [...walk(path.join(ROOT, 'build-plugins')), path.join(ROOT, 'App.tsx')];
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (Q_EMIT_RX.test(line)) {
          offenders.push(`  ${path.relative(ROOT, file)}:${i + 1} → ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `Internal ?q= outlink(s) found — route to a crawlable canonical/hub URL instead (rel="nofollow" is banned on internal links):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
