import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Slug-write encapsulation invariant — issue #5157.
 *
 * A lost `previousSlug` is a lost redirect: an URL Google already indexed
 * starts answering 404 and the ranking it had earned is gone. The recovery
 * workflow's tripwire fired at 79 losses in 24h against a threshold of 10,
 * spread thinly over 21 commits and a dozen crawlers — the signature of a
 * rule many authors independently forget, not of one broken commit.
 *
 * The structural fix has two halves, and this file pins both:
 *
 *   1. ENCAPSULATION — `scripts/lib/slug-preservation-guard.mjs` runs inside
 *      `writeJsonAtomic`, so a write to a job slice physically cannot drop a
 *      slug the previous on-disk version could serve. This is what makes the
 *      loss impossible rather than merely discouraged.
 *
 *   2. THIS TEST — a ratchet on direct writes to the slug fields. The guard
 *      covers anyone who forgets; the ratchet stops the population of
 *      forgetters from growing, and keeps the remaining debt enumerated
 *      instead of anonymous.
 *
 * Writes are extracted from the real TypeScript AST, not a text regex — the
 * same technique `tests/packages-articles-confinement.test.ts` uses, and for
 * the same reason: these scripts are full of slug STRINGS and comments about
 * slugs, and only a parsed assignment target is actually a write.
 */

const SCRIPTS_ROOT = path.resolve(__dirname, '..', 'scripts');

/** Fields whose value IS a live URL — dropping one retires an indexed page. */
const ACTIVE_SLUG_FIELDS = new Set(['slug', 'slugByLocale']);
/** Fields holding the redirect history that keeps retired URLs resolving. */
const ARCHIVE_SLUG_FIELDS = new Set(['previousSlugs', 'previousSlugsByLocale']);
const GUARDED_FIELDS = new Set([...ACTIVE_SLUG_FIELDS, ...ARCHIVE_SLUG_FIELDS]);

const ARRAY_MUTATORS = new Set([
  'push', 'splice', 'unshift', 'pop', 'shift', 'sort', 'reverse', 'fill', 'copyWithin',
]);

/**
 * Modules ALLOWED to write the slug fields directly — they are the
 * implementation of the journaling/preservation contract itself.
 */
const AUTHORIZED_MODULES = new Set([
  'lib/dedicated-crawler-common.mjs',   // addPreviousSlugForLocale / captureLostSlugs
  'lib/slug-history-journal.mjs',       // recordSlugMutation / capSlugArray
  'lib/slug-preservation-guard.mjs',    // the write-boundary guard
]);

/**
 * Pinned debt: every module that still writes a slug field directly, with the
 * exact number of such writes as of the #5157 fix.
 *
 * This is a RATCHET, not an approval list. The count may only go DOWN.
 *   - a new entry  → a new unjournaled slug-write path was introduced;
 *   - a higher count → an existing path grew another one;
 *   - a lower count → someone removed one: lower the pin in the same commit.
 *
 * To retire an entry, route the write through `addPreviousSlugForLocale` /
 * `captureLostSlugs` (scripts/lib/dedicated-crawler-common.mjs) and delete
 * the line here.
 */
const DIRECT_WRITE_BASELINE: Record<string, number> = {
  'assemble-jobs-dataset.mjs': 2,
  'audit-jobs-source-match.mjs': 1,
  'backfill-orphan-slugs-from-registry.mjs': 4,
  'backfill-prev-slugs-from-loss-events.mjs': 5,
  'backfill-renamed-slugs-from-history.mjs': 2,
  'backfill-slug-aliases.mjs': 9,
  'build-fiscal-municipalities.mjs': 1,
  'build-prev-slug-restore-denylist.mjs': 2,
  'clean-lis-data.mjs': 3,
  'cleanup-redundant-previous-slugs.mjs': 1,
  'decontaminate-prev-slugs.mjs': 7,
  'download-company-logos.mjs': 1,
  'lib/canton-ticino-osc-job-parser.mjs': 1,
  'lib/clinica-hildebrand-job-parser.mjs': 1,
  'lib/clinica-varini-job-parser.mjs': 1,
  'lib/crawler-template.mjs': 6,
  'lib/oscam-castelrotto-job-parser.mjs': 1,
  'lib/reha-andeer-job-parser.mjs': 1,
  'lib/shared-jobs-crawler.mjs': 5,
  'lib/therapiezentrum-meggen-job-parser.mjs': 1,
  'migrate-collapsed-job-ids.mjs': 2,
  'migrate-previous-slugs-to-locale-aware.mjs': 6,
  'quality-alerts.mjs': 1,
  'reconcile-job-slugs.mjs': 4,
  'regenerate-slugs-by-locale.mjs': 4,
  'repair-translations.mjs': 1,
  'repair-unicode-escape-titles.mjs': 4,
  'scrub-hilcona-undefined-active-slugs.mjs': 2,
  'sync-gsc-orphans.mjs': 3,
  'update-efg-jobs.mjs': 1,
  'update-eoc-jobs.mjs': 7,
  'update-grace-jobs.mjs': 2,
  'update-lis-jobs.mjs': 2,
  'update-medacta-jobs.mjs': 1,
  'update-postch-jobs.mjs': 1,
  'update-postfinance-jobs.mjs': 1,
  'update-skyguide-jobs.mjs': 1,
  'update-sunrise-jobs.mjs': 3,
  'update-supsi-jobs.mjs': 1,
  'update-usi-jobs.mjs': 5,
};

interface Write {
  file: string;
  line: number;
  field: string;
  kind: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The guarded field a write target resolves to, or null.
 *
 * Handles `job.previousSlugs = …` (property access) and
 * `job.slugByLocale[locale] = …` (element access into a guarded property).
 */
function targetField(node: ts.Expression): string | null {
  if (ts.isElementAccessExpression(node)) {
    const obj = node.expression;
    if (ts.isPropertyAccessExpression(obj) && GUARDED_FIELDS.has(obj.name.text)) return obj.name.text;
    return null;
  }
  if (ts.isPropertyAccessExpression(node) && GUARDED_FIELDS.has(node.name.text)) return node.name.text;
  return null;
}

/** Every direct write to a guarded slug field in one file, via the TS AST. */
function extractSlugWrites(filePath: string, source: string, rel: string): Write[] {
  const scriptKind = /\.(mjs|js)$/.test(filePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const writes: Write[] = [];
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsToken ||
        op === ts.SyntaxKind.PlusEqualsToken ||
        op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        op === ts.SyntaxKind.BarBarEqualsToken
      ) {
        const field = targetField(node.left);
        if (field) writes.push({ file: rel, line: at(node), field, kind: 'assignment' });
      }
    }
    if (ts.isDeleteExpression(node)) {
      const field = targetField(node.expression);
      if (field) writes.push({ file: rel, line: at(node), field, kind: 'delete' });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (ARRAY_MUTATORS.has(method)) {
        const field = targetField(node.expression.expression);
        if (field) writes.push({ file: rel, line: at(node), field, kind: `.${method}()` });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return writes;
}

function collectWrites(): { files: string[]; byFile: Map<string, Write[]> } {
  const files = walk(SCRIPTS_ROOT);
  const byFile = new Map<string, Write[]>();
  for (const file of files) {
    const rel = path.relative(SCRIPTS_ROOT, file);
    if (AUTHORIZED_MODULES.has(rel)) continue;
    const writes = extractSlugWrites(file, fs.readFileSync(file, 'utf-8'), rel);
    if (writes.length > 0) byFile.set(rel, writes);
  }
  return { files, byFile };
}

describe('slug-write encapsulation (issue #5157)', () => {
  const { files, byFile } = collectWrites();

  it('walks a non-trivial number of scripts (sanity-check the walker)', () => {
    // Guards against a silently-empty walk (e.g. SCRIPTS_ROOT typo) making
    // every invariant below vacuously pass.
    expect(files.length).toBeGreaterThan(500);
  });

  it('every authorized module exists — the exemption list cannot rot', () => {
    for (const rel of AUTHORIZED_MODULES) {
      expect(fs.existsSync(path.join(SCRIPTS_ROOT, rel)), `${rel} is exempted but missing`).toBe(true);
    }
  });

  it('introduces no NEW module that writes a slug field directly', () => {
    const newcomers = [...byFile.keys()]
      .filter(rel => !(rel in DIRECT_WRITE_BASELINE))
      .map((rel) => {
        const lines = byFile.get(rel)!.map(w => `      L${w.line} ${w.field} (${w.kind})`).join('\n');
        return `  ${rel}\n${lines}`;
      });

    expect(
      newcomers,
      newcomers.length === 0 ? '' :
        `New direct slug-field writer(s) detected.\n\n` +
        `Writing a slug without journaling is how issue #5157 happened: 79 indexed\n` +
        `URLs started 404ing because the old value was overwritten with no capture.\n\n` +
        `Route the write through addPreviousSlugForLocale() / captureLostSlugs()\n` +
        `in scripts/lib/dedicated-crawler-common.mjs, which capture the outgoing\n` +
        `slug into previousSlugsByLocale and journal the mutation.\n\n` +
        `Offending file(s):\n${newcomers.join('\n')}\n`,
    ).toEqual([]);
  });

  it('does not grow the direct-write count of any module already carrying debt', () => {
    const grown: string[] = [];
    for (const [rel, pinned] of Object.entries(DIRECT_WRITE_BASELINE)) {
      const actual = byFile.get(rel)?.length ?? 0;
      if (actual > pinned) grown.push(`  ${rel}: ${pinned} pinned → ${actual} found (+${actual - pinned})`);
    }
    expect(
      grown,
      grown.length === 0 ? '' :
        `A module added another direct slug-field write.\n\n` +
        `The baseline is a ratchet — it may only shrink. Route the new write\n` +
        `through addPreviousSlugForLocale() / captureLostSlugs() instead.\n\n${grown.join('\n')}\n`,
    ).toEqual([]);
  });

  it('keeps the pinned baseline honest — a removed write must lower its pin', () => {
    const stale: string[] = [];
    for (const [rel, pinned] of Object.entries(DIRECT_WRITE_BASELINE)) {
      const actual = byFile.get(rel)?.length ?? 0;
      if (actual < pinned) {
        stale.push(
          actual === 0
            ? `  ${rel}: fully cleaned up — delete this line from DIRECT_WRITE_BASELINE`
            : `  ${rel}: ${pinned} pinned → ${actual} found — lower the pin to ${actual}`,
        );
      }
    }
    expect(
      stale,
      stale.length === 0 ? '' :
        `Direct slug-field writes were removed (thank you) but the baseline still\n` +
        `claims them. Update tests/slug-write-encapsulation.test.ts so the ratchet\n` +
        `keeps its grip at the new, lower level.\n\n${stale.join('\n')}\n`,
    ).toEqual([]);
  });
});

describe('the write-boundary guard cannot be quietly removed (issue #5157)', () => {
  const atomicWriter = path.join(SCRIPTS_ROOT, 'lib', 'atomic-write-json.mjs');

  /** Names of functions called anywhere in a module, via the AST. */
  function calledFunctions(filePath: string): Set<string> {
    const source = fs.readFileSync(filePath, 'utf-8');
    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const names = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) names.add(node.expression.text);
        else if (ts.isPropertyAccessExpression(node.expression)) names.add(node.expression.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return names;
  }

  it('writeJsonAtomic still runs preserveSlugHistory on every write', () => {
    // This is THE load-bearing line of the fix: it is what makes dropping a
    // slug impossible rather than merely discouraged. Deleting it would
    // silently restore the #5157 failure mode across all ~40 slice writers.
    expect(
      calledFunctions(atomicWriter).has('preserveSlugHistory'),
      'scripts/lib/atomic-write-json.mjs no longer calls preserveSlugHistory(). ' +
      'Every job-slice write would again be free to drop an indexed URL silently — ' +
      'see issue #5157. Restore the call, or replace it with an equivalent ' +
      'boundary guard and re-point this test at it.',
    ).toBe(true);
  });

  it('the guard module still exports its enforcement surface', () => {
    const guard = path.join(SCRIPTS_ROOT, 'lib', 'slug-preservation-guard.mjs');
    const source = fs.readFileSync(guard, 'utf-8');
    const sf = ts.createSourceFile(guard, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const exported = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exported.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect([...exported]).toEqual(expect.arrayContaining(['preserveSlugHistory', 'reachableSlugs']));
  });
});
