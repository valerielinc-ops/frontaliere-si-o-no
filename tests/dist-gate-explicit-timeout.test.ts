/**
 * OBSERVER for issue #5729 — "a passing dist gate must never be reported as
 * a timeout".
 *
 * THE DEFECT THIS GUARDS
 * ----------------------
 * `vitest.config.ts` sets `testTimeout: 15000`. Every gate in
 * `npm run gate:dist-quality` walks `dist/**\/*.html`, which the 2026-08-14
 * post-deploy run measured at **3,798,763 files** — minutes of work, all of
 * it in a SYNCHRONOUS test body.
 *
 * Vitest cannot interrupt a synchronous body. The timeout it races against
 * the test is a timer, and a blocking body never yields to the event loop, so
 * the timer can only fire once the body has already run to completion. It
 * then wins that race **only when the body returned normally** — because a
 * body that throws settles the race with its own error first. The observable
 * consequence, reproduced by mutation (a 600 ms busy-wait under a 200 ms
 * timeout):
 *
 *     PASSES -> "Error: Test timed out in 200ms"     <- a LIE
 *     THROWS -> "Error: REAL CONTENT FAILURE"        <- the truth
 *
 * So the gate reported its *passing* assertions as failures and its *failing*
 * assertions correctly. In the run that reopened #5729 for the fourth time,
 * **7 of 14 reported failures were tests that had actually passed**, which is
 * why the gate read as a scan-speed problem and why two separate "fix the
 * scan" attempts could not move it.
 *
 * THE CONTRACT
 * ------------
 * Any test in a `gate:dist-quality` file that reaches the filesystem — either
 * directly, or through a module-level helper that does — MUST declare an
 * explicit `timeout` in its options object. An explicit timeout costs nothing
 * in wall time (it never truncated anything) and is the only thing that makes
 * the pass/fail report honest.
 *
 * The gate's file list is read from `package.json` rather than hard-coded, so
 * a gate added to `gate:dist-quality` tomorrow is covered without anyone
 * remembering to update this test.
 *
 * Structural, not behavioural: parses TypeScript with the compiler API (the
 * same approach as `tests/packages-articles-confinement.test.ts`) and needs
 * no `dist/`, so it runs in milliseconds on every `npm test`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { SCAN_TEST_TIMEOUT_MS } from './helpers/distHtmlScan';

const ROOT = resolve(__dirname, '..');

/**
 * Node fs primitives whose cost scales with dist/. A helper that calls one of
 * these — or a helper that calls such a helper — makes its callers slow.
 */
const IO_PRIMITIVES = new Set([
  'readFileSync',
  'readdirSync',
  'statSync',
  'scanDistHtml',
]);

/** Test-declaring callees whose bodies this contract inspects. */
const TEST_CALLEES = new Set(['it', 'test']);

/**
 * Names that stand for CORPUS-scale work: the rehydrated `dist/` tree and the
 * CI-assembled `data/jobs.json`. Both are unbounded — the 2026-08-14 run
 * measured 3,798,763 HTML files in dist/, and the dataset is hundreds of MB —
 * so a test that reaches either one cannot be assumed to finish inside a
 * 15s default, whatever it does with what it reads.
 */
const CORPUS_HELPERS = new Set(['scanDistHtml', 'readJobsDataset']);

/**
 * A module-level constant whose initializer names the corpus, e.g.
 * `const DIST = path.resolve(__dirname, '../../dist')` or
 * `const JOBS_PATH = path.resolve(__dirname, '../../data/jobs.json')`.
 */
const CORPUS_PATH_RE = /(^|[/'"`])dist($|[/'"`])|jobs\.json/;

/**
 * The two gates this contract covers, and the seed set each one taints from.
 *
 * `gate:dist-quality` files exist only to walk dist/, so ANY fs primitive in
 * them is corpus-scale — that is the seed the gate shipped with (#5729).
 * `gate:seo-source` is a 112-file suite where most `readFileSync` calls read
 * one build-plugin source and cost microseconds; seeding it with the same
 * primitives would flag 63 tests that have nothing to do with this defect.
 * There the seed is the corpus itself: dist/ and data/jobs.json.
 */
const GATES: readonly { readonly script: string; readonly seeds: 'io' | 'corpus' }[] = [
  { script: 'gate:dist-quality', seeds: 'io' },
  { script: 'gate:seo-source', seeds: 'corpus' },
];

/**
 * The test files a gate script actually runs, read from the script itself so
 * this contract cannot drift from the gate.
 *
 * A script may name files (`tests/x.test.ts`) or a directory
 * (`gate:seo-source` runs `vitest run tests/seo/`); a directory is expanded to
 * the `*.test.ts` files under it, so a gate that grows a file tomorrow is
 * covered without anyone remembering to update this test.
 */
function gateFiles(script: string): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  const cmd = pkg.scripts?.[script];
  if (!cmd) throw new Error(`package.json has no \`${script}\` script`);
  const tokens = cmd.match(/\btests\/[\w./-]*/g) ?? [];
  const files: string[] = [];
  for (const token of tokens) {
    if (token.endsWith('.test.ts')) {
      files.push(token);
      continue;
    }
    const dir = token.replace(/\/$/, '');
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(`${dir}/${entry.name}`);
    }
  }
  if (files.length === 0) {
    throw new Error(`no test files parsed out of ${script}: ${cmd}`);
  }
  return [...new Set(files)];
}

/** Every identifier name appearing anywhere under `node`. */
function identifiersIn(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) names.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}

/**
 * Names of module-level bindings that transitively reach the seed set.
 * Fixpoint: seed with the primitives (or with the corpus, see {@link GATES}),
 * then repeatedly admit any binding whose body references something already in
 * the set.
 *
 * Under the `corpus` seed a plain constant counts too, not just a function: a
 * test is corpus-scale because it names `DIST`, and that name is a `const`.
 */
function ioReachingNames(sf: ts.SourceFile, seeds: 'io' | 'corpus'): Set<string> {
  const bodies = new Map<string, Set<string>>();
  const tainted = new Set(seeds === 'io' ? IO_PRIMITIVES : CORPUS_HELPERS);
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      bodies.set(stmt.name.text, identifiersIn(stmt.body));
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const isFn =
          ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer);
        if (seeds === 'io' && !isFn) continue;
        bodies.set(decl.name.text, identifiersIn(decl.initializer));
        if (seeds === 'corpus' && !isFn && CORPUS_PATH_RE.test(decl.initializer.getText(sf))) {
          tainted.add(decl.name.text);
        }
      }
    }
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, refs] of bodies) {
      if (tainted.has(name)) continue;
      for (const r of refs) {
        if (tainted.has(r)) {
          tainted.add(name);
          grew = true;
          break;
        }
      }
    }
  }
  return tainted;
}

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly title: string;
  /** `missing` = no timeout at all; `<n>ms` = one too small to be honest. */
  readonly reason: string;
}

/** Numeric value of a timeout expression, when it can be read statically. */
function timeoutValue(expr: ts.Expression, sf: ts.SourceFile): number | undefined {
  if (ts.isNumericLiteral(expr)) return Number(expr.text.replace(/_/g, ''));
  if (!ts.isIdentifier(expr)) return undefined;
  // `SCAN_TEST_TIMEOUT_MS` is imported, so its initializer is not in this file.
  if (expr.text === 'SCAN_TEST_TIMEOUT_MS') return SCAN_TEST_TIMEOUT_MS;
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.name.text === expr.text &&
        decl.initializer &&
        ts.isNumericLiteral(decl.initializer)
      ) {
        return Number(decl.initializer.text.replace(/_/g, ''));
      }
    }
  }
  return undefined;
}

/**
 * Why `it('…', { timeout: N }, fn)` fails the contract, or `undefined` when it
 * passes.
 *
 * A timeout that is merely EXPLICIT is not enough: the number must also exceed
 * the scan it bounds. `tests/seo/cathedral-sitemap-emit-consistency.test.ts`
 * declared `120_000` and still reported "Test timed out in 120000ms" on the
 * 2026-09-04 post-deploy run (issue #7373) — the same #5729 inversion, only
 * with a hand-picked ceiling instead of the default one. The shared ceiling
 * {@link SCAN_TEST_TIMEOUT_MS} is the one number to raise if a corpus ever
 * outgrows it, and raising it costs nothing in wall time: vitest cannot
 * interrupt a synchronous body, so the timeout never truncated anything.
 */
function timeoutDefect(call: ts.CallExpression, sf: ts.SourceFile): string | undefined {
  for (const arg of call.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const p of arg.properties) {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) || p.name.text !== 'timeout') {
        continue;
      }
      const value = timeoutValue(p.initializer, sf);
      // Unreadable statically (an expression, an imported alias): the author
      // made a deliberate choice this parser cannot second-guess — accept it.
      if (value === undefined || value >= SCAN_TEST_TIMEOUT_MS) return undefined;
      return `${value}ms < SCAN_TEST_TIMEOUT_MS (${SCAN_TEST_TIMEOUT_MS}ms)`;
    }
  }
  return 'missing';
}

function scanFile(rel: string, seeds: 'io' | 'corpus'): Offender[] {
  const abs = join(ROOT, rel);
  const src = readFileSync(abs, 'utf-8');
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true);
  const tainted = ioReachingNames(sf, seeds);
  const offenders: Offender[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // `it(...)` / `test(...)` only — `it.skip(...)` never runs, and
      // `it.each(...)`-style chains carry their own shape.
      if (ts.isIdentifier(callee) && TEST_CALLEES.has(callee.text)) {
        const body = node.arguments.find(
          (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
        );
        const defect = body ? timeoutDefect(node, sf) : undefined;
        if (body && defect) {
          const refs = identifiersIn(body);
          let touchesIo = false;
          for (const r of refs) {
            if (tainted.has(r)) {
              touchesIo = true;
              break;
            }
          }
          if (touchesIo) {
            const titleArg = node.arguments[0];
            const title =
              titleArg && ts.isStringLiteralLike(titleArg) ? titleArg.text : '<computed>';
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            offenders.push({ file: rel, line: line + 1, title, reason: defect });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return offenders;
}

describe.each(GATES)('$script — every corpus-scanning test declares an honest timeout', ({ script, seeds }) => {
  it(`no corpus-scanning test in ${script} can be reported as a timeout while passing`, () => {
    const files = gateFiles(script);
    const offenders = files.flatMap((f) => scanFile(f, seeds));

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `These tests reach the corpus (dist/, data/jobs.json) without a timeout ` +
          `large enough to outlast the scan. Because their bodies are synchronous, ` +
          `vitest cannot interrupt them — they run to completion and are then reported ` +
          `as "Test timed out" IF THEY PASS, while genuine failures show their real ` +
          `error. That inversion is issue #5729; the too-small explicit ceiling is ` +
          `issue #7373.\n\n` +
          offenders.map((o) => `  - ${o.file}:${o.line} — "${o.title}" (${o.reason})`).join('\n') +
          `\n\nFix: pass the shared ceiling, ` +
          `it('…', { timeout: SCAN_TEST_TIMEOUT_MS }, () => { … }).`,
    ).toEqual([]);
  });

  it('the gate script is still parseable and non-empty', () => {
    expect(gateFiles(script).length).toBeGreaterThan(0);
  });
});
