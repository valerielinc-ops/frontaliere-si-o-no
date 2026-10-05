// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The non-IT locale source artifact: deploy.yml packs it, deploy-publish.yml
 * unpacks it. The unpacking side may REQUIRE only what the packing side
 * ALWAYS puts in.
 *
 * Failure title if this goes red:
 *   «Publish: la coda non-IT pretende dal sorgente un file che il deploy non garantisce»
 *
 * The pack adds the flat homepage `<loc>.html` only `if [ -f … ]`, but the
 * extract step ran `test -s "dist/${BUILD_LOCALE}.html"`: every non-IT tail
 * failed right after a good extract, with no message, on publish runs
 * 37255215160 and 37271778943 (05-10), and en/de/fr stayed unpublished.
 */

const ROOT = resolve(import.meta.dirname, '..');
type Step = { name?: string; run?: string };
type Wf = { jobs: Record<string, { steps?: Step[] }> };

function stepRun(file: string, name: string): string {
  const wf = parse(readFileSync(resolve(ROOT, '.github/workflows', file), 'utf8')) as Wf;
  const step = Object.values(wf.jobs).flatMap((j) => j.steps ?? []).find((s) => s.name === name);
  expect(step?.run, `step «${name}» not found in ${file}`).toBeTruthy();
  return step!.run!;
}

/** Members the pack step puts in unconditionally, as dist-relative paths with `<loc>` for the locale. */
export function alwaysPackedMembers(packRun: string): string[] {
  const m = packRun.match(/^\s*members=\(([^)]*)\)/m);
  if (!m) return [];
  return m[1]
    .replace(/\$\{\{\s*matrix\.locale\s*\}\}/g, '<loc>')
    .trim()
    .split(/\s+/)
    .map((tok) => tok.replace(/^"|"$/g, ''));
}

/** dist-relative paths the extract step treats as fatal when missing. */
export function requiredExtractPaths(extractRun: string): string[] {
  const out = new Set<string>();
  const fatal = [
    /^\s*test -s "?dist\/([^"\s]+)"?\s*$/gm,
    /\[ -s "?dist\/([^"\s]+)"? \]\s*\|\|\s*(?:fail|exit)\b/g,
  ];
  for (const re of fatal) {
    for (const m of extractRun.matchAll(re)) out.add(m[1].replace('${BUILD_LOCALE}', '<loc>'));
  }
  return [...out].sort();
}

/** A required path is covered when it IS an always-packed file or lies inside an always-packed directory. */
export function uncoveredRequirements(required: string[], packed: string[]): string[] {
  return required.filter((p) => !packed.some((m) => p === m || p.startsWith(`${m}/`)));
}

describe('non-IT source artifact: the extract requires only what the pack always includes', () => {
  const packRun = stepRun('deploy.yml', 'Pack non-IT locale shard source artifact');
  const extractRun = stepRun('deploy-publish.yml', 'Extract non-IT source artifact');

  it('the pack always includes the locale subtree and build-id.txt', () => {
    expect(alwaysPackedMembers(packRun)).toEqual(['<loc>', 'build-id.txt']);
  });

  it('every fatal check of the extract is covered by an always-packed member', () => {
    const required = requiredExtractPaths(extractRun);
    expect(required).toEqual(expect.arrayContaining(['build-id.txt', '<loc>/index.html']));
    expect(uncoveredRequirements(required, alwaysPackedMembers(packRun))).toEqual([]);
  });

  it('a missing flat homepage is reported, not fatal', () => {
    expect(extractRun).toMatch(/if \[ ! -s "dist\/\$\{BUILD_LOCALE\}\.html" \]; then\s*\n\s*echo "::warning/);
  });

  it('the checker goes red on the 05-10 shape', () => {
    const old = [
      'test -s dist/build-id.txt',
      'test -s "dist/${BUILD_LOCALE}.html"',
      'test -s "dist/${BUILD_LOCALE}/index.html"',
    ].join('\n');
    expect(uncoveredRequirements(requiredExtractPaths(old), ['<loc>', 'build-id.txt'])).toEqual(['<loc>.html']);
  });
});
