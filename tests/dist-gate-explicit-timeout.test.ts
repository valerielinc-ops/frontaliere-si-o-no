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
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

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
 * The files `npm run gate:dist-quality` actually runs, read from the script
 * itself so this contract cannot drift from the gate.
 */
function gateFiles(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  const script = pkg.scripts?.['gate:dist-quality'];
  if (!script) throw new Error('package.json has no `gate:dist-quality` script');
  const files = script.match(/\btests\/[\w./-]*\.test\.ts\b/g) ?? [];
  if (files.length === 0) {
    throw new Error(`no test files parsed out of gate:dist-quality: ${script}`);
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
 * Names of module-level functions that transitively reach an IO primitive.
 * Fixpoint: seed with the primitives, then repeatedly admit any function
 * whose body references something already in the set.
 */
function ioReachingNames(sf: ts.SourceFile): Set<string> {
  const bodies = new Map<string, Set<string>>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      bodies.set(stmt.name.text, identifiersIn(stmt.body));
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          bodies.set(decl.name.text, identifiersIn(decl.initializer));
        }
      }
    }
  }

  const tainted = new Set(IO_PRIMITIVES);
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
}

/** `it('…', { timeout: N }, fn)` — an options object carrying `timeout`. */
function declaresTimeout(call: ts.CallExpression): boolean {
  return call.arguments.some(
    (arg) =>
      ts.isObjectLiteralExpression(arg) &&
      arg.properties.some(
        (p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          ts.isIdentifier(p.name) &&
          p.name.text === 'timeout',
      ),
  );
}

function scanFile(rel: string): Offender[] {
  const abs = join(ROOT, rel);
  const src = readFileSync(abs, 'utf-8');
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true);
  const tainted = ioReachingNames(sf);
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
        if (body && !declaresTimeout(node)) {
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
            offenders.push({ file: rel, line: line + 1, title });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return offenders;
}

describe('gate:dist-quality — every dist-scanning test declares an explicit timeout', () => {
  it('no dist-scanning test relies on the 15s default testTimeout', () => {
    const files = gateFiles();
    const offenders = files.flatMap(scanFile);

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `These tests reach the filesystem but inherit vitest.config.ts's ` +
          `\`testTimeout: 15000\`. Because their bodies are synchronous, vitest cannot ` +
          `interrupt them — they will run to completion and then be reported as ` +
          `"Test timed out in 15000ms" IF THEY PASS, while genuine failures show their ` +
          `real error. That inversion is issue #5729.\n\n` +
          offenders.map((o) => `  - ${o.file}:${o.line} — "${o.title}"`).join('\n') +
          `\n\nFix: pass an explicit timeout, e.g. ` +
          `it('…', { timeout: SCAN_TEST_TIMEOUT_MS }, () => { … }).`,
    ).toEqual([]);
  });

  it('the gate script is still parseable and non-empty', () => {
    expect(gateFiles().length).toBeGreaterThan(0);
  });
});
