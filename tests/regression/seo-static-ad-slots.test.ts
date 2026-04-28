/**
 * Regression: F2/F5/F6 build-plugin render functions must each contain
 * exactly one `adSlotHtml(...)` call.
 *
 * Why this exists: the GA4↔AdSense link analysis on 2026-04-28 showed
 * €0/30d revenue on these page types because the rendered HTML had no
 * `<ins class="adsbygoogle">` slots. Once added, regressions are easy
 * (e.g. someone refactors the render and drops the adSlotHtml call).
 * This test guards against silent revenue loss.
 *
 * The assertion is over the SOURCE TEXT — not the rendered HTML — because
 * the full render pipeline needs Firebase Remote Config, gigabyte-sized
 * datasets, and IO that are out-of-scope for a fast regression test. We
 * scope the search to each `function ${name}(` … next `function ` boundary
 * so we exactly match plan Step 2 ("inject … in the page render functions").
 *
 * If a render function legitimately needs zero ad slots, the fix is to
 * update this list — DO NOT silently remove the slot to make the test pass
 * (CLAUDE.md non-negotiable rule #1).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

interface Spec {
  file: string;
  fn: string;
  expectedSlot: 'JOBLIST_END_MULTIPLEX' | 'ARTICLE_END_MULTIPLEX';
}

const SPECS: Spec[] = [
  // F5 weekly-employers — 2 render funcs, JOBLIST slot
  { file: 'build-plugins/weeklyEmployersPlugin.ts', fn: 'renderWeeklyEmployersPage', expectedSlot: 'JOBLIST_END_MULTIPLEX' },
  { file: 'build-plugins/weeklyEmployersPlugin.ts', fn: 'renderCompanyCityPage', expectedSlot: 'JOBLIST_END_MULTIPLEX' },
  // F2 health-premiums — 3 render funcs, ARTICLE slot
  { file: 'build-plugins/healthPremiumsLandingPlugin.ts', fn: 'renderLeafPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  { file: 'build-plugins/healthPremiumsLandingPlugin.ts', fn: 'renderCantonHubPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  { file: 'build-plugins/healthPremiumsLandingPlugin.ts', fn: 'renderRootHubPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  // F6 fuel-daily — 5 render funcs, ARTICLE slot
  { file: 'build-plugins/fuelDailyPagesPlugin.ts', fn: 'renderPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  { file: 'build-plugins/fuelDailyPagesPlugin.ts', fn: 'renderArchive', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  { file: 'build-plugins/fuelDailyPagesPlugin.ts', fn: 'renderStationPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  { file: 'build-plugins/fuelDailyPagesPlugin.ts', fn: 'renderItalianCityPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  { file: 'build-plugins/fuelDailyPagesPlugin.ts', fn: 'renderItalianStationPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
];

/**
 * Extract the source body of a top-level render function by scanning from
 * `function <name>(` (or `export function <name>(`) to the next top-level
 * `function ` declaration. Good enough for these plugins; they don't nest
 * `function` keywords inside the render bodies (they use arrow callbacks).
 */
function extractFunctionBody(source: string, fnName: string): string {
  const opener = new RegExp(`(?:^|\\n)(?:export\\s+)?function\\s+${fnName}\\s*[<(]`);
  const start = source.search(opener);
  if (start === -1) return '';
  const rest = source.slice(start + 1);
  const nextFnIdx = rest.search(/\n(?:export\s+)?function\s+\w+\s*[<(]/);
  return nextFnIdx === -1 ? rest : rest.slice(0, nextFnIdx);
}

describe('SEO static-page ad slots — regression guard', () => {
  for (const spec of SPECS) {
    it(`${spec.file} :: ${spec.fn} contains exactly one adSlotHtml('${spec.expectedSlot}') call`, () => {
      const filePath = path.join(ROOT, spec.file);
      const src = fs.readFileSync(filePath, 'utf8');
      const body = extractFunctionBody(src, spec.fn);
      expect(body, `Could not locate function ${spec.fn} in ${spec.file}`).not.toBe('');

      const calls = body.match(/adSlotHtml\(\s*['"][A-Z_]+['"]\s*\)/g) ?? [];
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(spec.expectedSlot);
    });
  }

  it('helper imports the centralized adSlotHtml from build-plugins/lib/adSlotHtml', () => {
    const files = Array.from(new Set(SPECS.map(s => s.file)));
    for (const file of files) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(src, `${file} must import adSlotHtml from './lib/adSlotHtml'`)
        .toMatch(/import\s*\{\s*adSlotHtml\s*\}\s*from\s*['"]\.\/lib\/adSlotHtml['"]/);
    }
  });
});
