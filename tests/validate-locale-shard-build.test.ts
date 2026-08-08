// Coverage for scripts/ci/validate-locale-shard-build.mjs — the per-leg gate
// that proves a BUILD_LOCALE=<loc> shard build emitted ONLY its own locale.
//
// Behavioural, not structural: the property under test is what the script
// COUNTS as belonging to a locale, and a source-text assertion would pass
// against a regex-shaped stub. Every case below runs the real script against a
// throwaway dist/ fixture, with zero network and no build.
//
// The regression pinned here (build 31247086904, 2026-08-08): PR #5363 gave
// each locale its flat homepage `dist/<loc>.html`, this validator classified
// every root-level `*.html` as `it`, and all three non-IT legs failed with
// `locale 'it' was NOT in the shard set but emitted 1 pages (filter leak)` —
// it=1 en=822192 on the EN leg, symmetric on de/fr — while the immediately
// preceding build (pre-#5363) read it=0 and passed. Nothing leaked.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

/** A page the hreflang assertion (3) accepts: all four locales + x-default. */
const PAGE = [
  '<!DOCTYPE html><html><head>',
  '<link rel="alternate" hreflang="it" href="https://frontaliereticino.ch/">',
  '<link rel="alternate" hreflang="en" href="https://frontaliereticino.ch/en/">',
  '<link rel="alternate" hreflang="de" href="https://frontaliereticino.ch/de/">',
  '<link rel="alternate" hreflang="fr" href="https://frontaliereticino.ch/fr/">',
  '<link rel="alternate" hreflang="x-default" href="https://frontaliereticino.ch/">',
  '</head><body>pagina</body></html>',
].join('');

interface RunResult {
  status: number;
  output: string;
}

function write(root: string, rel: string, body = PAGE): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, 'utf8');
}

/**
 * Build a throwaway `dist/` from the given dist-relative paths and run the real
 * validator over it with BUILD_LOCALE=<locale>.
 */
function runValidator(locale: string, files: string[]): RunResult {
  const root = mkdtempSync(join(tmpdir(), 'locale-shard-val-'));
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  for (const rel of files) write(dist, rel);

  let status = 0;
  let output = '';
  try {
    output = execFileSync(
      'node',
      [resolve('scripts/ci/validate-locale-shard-build.mjs'), dist],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, BUILD_LOCALE: locale, GITHUB_STEP_SUMMARY: '' },
      },
    );
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    status = err.status ?? 1;
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { status, output };
}

describe('validate-locale-shard-build.mjs — `dist/<loc>.html` belongs to <loc> (#5363)', () => {
  it('PASSES on a locale leg that ships its own flat homepage', () => {
    // The exact shape of build 31247086904's EN leg after the prune: the `en`
    // subtree plus `dist/en.html`, which push-locale-shard.sh:196 stages as the
    // homepage answering `/en`.
    //
    // PRE-FIX: rc 1, `page counts: it=1`, and
    // `locale 'it' was NOT in the shard set but emitted 1 pages (filter leak)`.
    const { status, output } = runValidator('en', [
      'en/index.html',
      'en/lavoro/index.html',
      'en.html',
    ]);
    expect(output).toContain('page counts: it=0');
    expect(output).not.toContain('filter leak');
    expect(output).toContain('✓ Locale shard validation PASSED');
    expect(status).toBe(0);
  });

  it('counts the homepage toward its own locale, not as an extra IT page', () => {
    // Attribution, not exemption — `en` is 3 (2 subtree + 1 homepage), not 2.
    // This is what makes the reverse-direction leak detectable below.
    const { output } = runValidator('en', ['en/index.html', 'en/lavoro/index.html', 'en.html']);
    expect(output).toMatch(/page counts: it=0\s+en=3\s+de=0\s+fr=0/);
  });

  it('still FAILS when a real IT page leaks into a locale shard', () => {
    // The leak the gate exists for: an Italian page inside the EN shard is
    // wrong-locale content served on a locale that does not own it.
    const { status, output } = runValidator('en', [
      'en/index.html',
      'en.html',
      'lavoro-ticino/index.html',
    ]);
    expect(status).toBe(1);
    expect(output).toContain("locale 'it' was NOT in the shard set but emitted 1 pages (filter leak)");
  });

  it('NOW catches the reverse leak: a stray dist/en.html on the it/main leg', () => {
    // Strictly stronger than before. The it leg runs this same step after the
    // same prune, whose main-shard branch drops non-owned locale homepages. A
    // surviving `dist/en.html` there is a real leak — and under the old rule it
    // counted toward `it`, the shard's OWN locale, so it could never be seen.
    const { status, output } = runValidator('it', ['index.html', 'lavoro/index.html', 'en.html']);
    expect(status).toBe(1);
    expect(output).toContain("locale 'en' was NOT in the shard set but emitted 1 pages (filter leak)");
  });

  it('is anchored on the whole filename — lookalike root pages stay IT', () => {
    // `enigma.html` / `frontalieri.html` merely START with a locale code. A
    // prefix match would hand them to en/fr and invent a leak on the it leg.
    const { status, output } = runValidator('it', [
      'index.html',
      'enigma.html',
      'frontalieri.html',
      'de-che-cosa-sapere.html',
    ]);
    expect(output).toMatch(/page counts: it=4\s+en=0\s+de=0\s+fr=0/);
    expect(status).toBe(0);
  });

  it('keeps the empty-subtree assertion: a locale leg with no pages still fails', () => {
    const { status, output } = runValidator('en', ['en.html']);
    expect(status).toBe(1);
    expect(output).toContain("no sample index.html found for emitted locale 'en'");
  });

  it('agrees with localeOfDistPath() on who owns the flat homepage', () => {
    // The two live in different languages (this gate is plain .mjs run by node,
    // the emit filter is TS compiled into the build) so they cannot share a
    // module. They CAN disagree, and a disagreement is exactly this incident:
    // the filter shipped `dist/en.html` in the EN leg while the gate called it
    // an IT page. Pin the contract in both directions.
    const filter = readFileSync(resolve('build-plugins/shared/localeEmitFilter.ts'), 'utf8');
    expect(filter).toContain('THE ONE EXCEPTION');
    expect(filter).toContain('dist/<loc>.html');
    const gate = readFileSync(resolve('scripts/ci/validate-locale-shard-build.mjs'), 'utf8');
    expect(gate).toMatch(/\^\(en\|de\|fr\)\\\.html\$/);
    expect(gate).toContain('localeOfDistPath');
  });
});
