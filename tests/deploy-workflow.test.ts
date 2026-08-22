import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards for the parallel SEO audit-gate block in
 * .github/workflows/post-deploy-validate-dist.yml (gates were moved here from
 * deploy.yml in commit a2a7283f3c to avoid extending the critical deploy path)
 * and the tuned default flush concurrency in build-plugins/batchWrite.ts.
 *
 * These tests catch the most likely regression vectors:
 *   1) A new audit script is added to package.json but never wired into CI.
 *   2) A gate is moved out of the parallel block into a serial step (regressing
 *      validation time) without updating these assertions.
 *   3) The spawn_capped helper is replaced with serial execution.
 *   4) batchWrite default concurrency is downgraded below the tuned floor.
 */

const ROOT = resolve(import.meta.dirname, '..');
const VALIDATION_YML = readFileSync(resolve(ROOT, '.github/workflows/post-deploy-validate-dist.yml'), 'utf-8');
const DEPLOY_YML = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf-8');
// Every workflow that uploads dist/audit-reports/** as an artifact — the
// directory scripts/lib/auditReport.mjs writes to (discover-eligibility.json
// included). Since #6202 that report is written only 1-in-7 post-deploy
// runs, so an upload step over this path MUST tolerate a run where the
// directory is empty or absent (issue #6208 item 2).
const AUDIT_REPORTS_UPLOAD_WORKFLOWS = [
  '.github/workflows/post-deploy-validate-dist.yml',
  '.github/workflows/post-build-matrix-test.yml',
  '.github/workflows/cathedral-seo-gates-check.yml',
  '.github/workflows/audit-dist-from-run.yml',
  '.github/workflows/post-deploy-validate-live.yml',
] as const;
// Section rehydrate loop (rehydrate_section) lives here, extracted out of
// post-deploy-validate-dist.yml's 3 inline copies + the 4 seed-baseline
// workflows' copies into one shared script (AGENTS.md #6 dedupe).
const REHYDRATE_SECTION_SCRIPT = readFileSync(resolve(ROOT, 'scripts/lib/rehydrate-section-shards.sh'), 'utf-8');
// Locale rehydrate loop (rehydrate_locale) — same dedupe, extracted out of
// post-deploy-validate-dist.yml's 3 byte-identical inline copies (issue
// #4828) into one shared script.
const REHYDRATE_LOCALE_SCRIPT = readFileSync(resolve(ROOT, 'scripts/lib/rehydrate-locale-shards.sh'), 'utf-8');
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const BATCH_WRITE = readFileSync(resolve(ROOT, 'build-plugins/batchWrite.ts'), 'utf-8');
const AUDIT_ALL_REGISTRY_SRC = readFileSync(resolve(ROOT, 'scripts/audit-all.mjs'), 'utf-8');

// `audit:title-uniqueness` was moved to a separate weekly workflow because it
// OOM-killed the parallel block. All remaining gates must stay in parallel.
const AUDIT_SCRIPTS_IN_PARALLEL_BLOCK = [
  'audit:hreflang',
  'audit:content-duplicates',
  'audit:page-weight',
  'audit:text-html-ratio',
  'audit:h1-title-duplicates',
  'audit:title-length',
] as const;

/**
 * Parse the REGISTRY block of scripts/audit-all.mjs to extract the set of
 * audit names that the unified runner wraps. Each entry has the shape
 *   `{ factory: <ident>, name: '<audit-name>' }` — we match the `name: '…'`
 * literal so additions to the registry are automatically picked up.
 */
function parseAuditAllRegistry(src: string): Set<string> {
  const out = new Set<string>();
  const re = /\bname:\s*['"]([a-z][a-z0-9-]*)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(`audit:${m[1]}`);
  return out;
}

const AUDIT_ALL_WRAPS = parseAuditAllRegistry(AUDIT_ALL_REGISTRY_SRC);

/**
 * Returns true if the workflow invokes the audit either directly via
 * `npm run audit:<name>` OR transitively via `npm run audit:all` (when the
 * audit is registered in audit-all.mjs).
 */
function isInvokedDirectlyOrViaAuditAll(name: string): boolean {
  const directRe = new RegExp(`npm run ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  if (directRe.test(VALIDATION_YML)) return true;
  return AUDIT_ALL_WRAPS.has(name) && /npm run audit:all\b/.test(VALIDATION_YML);
}

describe('post-deploy-validate-dist.yml — parallel SEO audit gates', () => {
  it('every gate in the parallel block is defined in package.json', () => {
    const scripts = PACKAGE_JSON.scripts || {};
    for (const name of AUDIT_SCRIPTS_IN_PARALLEL_BLOCK) {
      expect(scripts[name], `missing npm script "${name}" referenced by post-deploy-validate-dist.yml`).toBeDefined();
    }
  });

  it('every gate is reachable from post-deploy-validate-dist.yml (directly or via audit:all)', () => {
    for (const name of AUDIT_SCRIPTS_IN_PARALLEL_BLOCK) {
      expect(
        isInvokedDirectlyOrViaAuditAll(name),
        `"${name}" is unreachable from post-deploy-validate-dist.yml. ` +
        `Either invoke it directly via \`npm run ${name}\`, or register it in ` +
        `scripts/audit-all.mjs REGISTRY (audit-all is invoked in workflow). ` +
        `audit-all currently wraps: ${[...AUDIT_ALL_WRAPS].sort().join(', ')}`,
      ).toBe(true);
    }
  });

  it('parallel block uses spawn_capped for background execution', () => {
    expect(
      VALIDATION_YML,
      'spawn_capped helper missing from post-deploy-validate-dist.yml — parallel execution regressed',
    ).toContain('spawn_capped()');
  });

  it('any new audit:* script added to package.json must be reachable in post-deploy-validate-dist.yml (direct or via audit:all)', () => {
    // Gates intentionally NOT in the dist-validate parallel block:
    // - `:rebaseline` variants mutate the checked-in baseline; never CI.
    // - `audit:title-uniqueness` runs on a separate weekly workflow because
    //   it OOM-killed the parallel block.
    // - `audit:dist-multi*` are aggregators that wrap other audits.
    // - `audit:parser-quality` is a developer self-test, not gated in CI.
    // - `audit:no-merge-markers` is a source gate wired into tests.yml and deploy.yml,
    //   not a dist-walking post-deploy gate.
    // - `audit:active-jobs-regression` is a pre-build data gate in deploy.yml.
    // - `audit:all` IS the wrapper itself; reachability check would be circular.
    // - `audit:job-locations` runs on its own separate weekly workflow
    //   (location-quality-audit.yml) — report-only monitoring, not a
    //   deploy-blocking dist gate (same pattern as audit:title-uniqueness).
    // - `audit:slug-prompt-leaks` (issue #5334) reads the article registries and
    //   the blog sitemaps in the SOURCE tree, never dist/, so it has nothing to
    //   contribute to a dist-walking block. Its enforcement is not deferred:
    //   the identical sweep, over the identical sources (it imports
    //   AUDIT_SOURCES / KNOWN_LEGACY_LEAKS from the script itself), runs on every
    //   PR in tests/article-slug-prompt-leak-guard.test.ts. This npm alias is
    //   the operator-facing form — the one that prints which slug and which
    //   pattern — not a second, weaker copy of the gate.
    // - `audit:sitemap-canonicals` is invoked THROUGH `validate:sitemap-pages`,
    //   which is spawn_capped in the same pool. That script is the consolidated
    //   sitemap validator and its "check 1" IS this audit, over the same
    //   dist/sitemap-*.xml set — see its own "Differences PRESERVED" header.
    //   Running the standalone alias too meant re-parsing 89 sitemaps and
    //   re-reading ~245'000 page <head>s to answer the same question twice
    //   (127.18 s on run 32261742920, where both reported the same single
    //   offender under two gate names). The consolidated copy is the
    //   better-scoped of the two: it excludes URLs served by the article shard
    //   repos, which is why the standalone reported 85 `missing-html` warnings
    //   on pages this build does not emit. The alias stays in package.json for
    //   `audit-dist-from-run.yml` replays and for operators.
    //   The claim "it still runs" is not left on trust — the assertion below
    //   this loop pins the consolidated validator's invocation.
    const GATES_NOT_IN_DIST_PARALLEL = new Set([
      'audit:title-uniqueness',
      'audit:dist-multi',
      'audit:parser-quality',
      'audit:no-merge-markers',
      'audit:active-jobs-regression',
      'audit:job-locations',
      'audit:slug-prompt-leaks',
      'audit:all',
      'audit:sitemap-canonicals',
    ]);
    const allAuditScripts = Object.keys(PACKAGE_JSON.scripts || {}).filter((k) => {
      return /^audit:/.test(k) && !/:rebaseline$/.test(k) && !GATES_NOT_IN_DIST_PARALLEL.has(k);
    });
    for (const name of allAuditScripts) {
      expect(
        isInvokedDirectlyOrViaAuditAll(name),
        `package.json defines "${name}" but post-deploy-validate-dist.yml has no reachable invocation — ` +
        `gate would never run. audit:all currently wraps: ${[...AUDIT_ALL_WRAPS].sort().join(', ')}`,
      ).toBe(true);
    }
  });

  it('the consolidated sitemap validator is invoked — it carries audit:sitemap-canonicals', () => {
    // `audit:sitemap-canonicals` is excluded from the loop above because
    // `validate:sitemap-pages` performs the identical check. That exclusion is
    // only safe while the consolidated validator actually runs, and while it
    // actually still contains the check. Without this, dropping
    // `validate:sitemap-pages` from the pool would silently retire BOTH.
    expect(
      isInvokedDirectlyOrViaAuditAll('validate:sitemap-pages'),
      'validate:sitemap-pages is no longer invoked in post-deploy-validate-dist.yml — ' +
        'audit:sitemap-canonicals is excluded from the reachability loop on the grounds ' +
        'that this script runs it, so both gates are now dead. Re-add one of them.',
    ).toBe(true);

    const consolidated = readFileSync(
      resolve(ROOT, 'scripts/validate-sitemap-pages.mjs'),
      'utf8',
    );
    expect(
      consolidated.includes('audit-sitemap-canonicals'),
      'scripts/validate-sitemap-pages.mjs no longer mentions audit-sitemap-canonicals — ' +
        'the check it was standing in for may have been removed.',
    ).toBe(true);
  });
});

/**
 * Guard for issue #6208 item 2: `audit:discover-eligibility` and
 * `seo/meta-description-audit` are report-only (rc=0 cabled) and, since
 * #6202, run at a 1-in-7 cadence — so `dist/audit-reports/discover-
 * eligibility.json` is absent on 6 of every 7 post-deploy runs. Every
 * `upload-artifact` step whose `path:` includes `dist/audit-reports/**` must
 * therefore tolerate a missing/empty directory (`if-no-files-found: ignore`
 * or `warn`), never `error` — an `error` setting would fail the job on the
 * 6-in-7 skipped runs for a "problem" that isn't one.
 */
function extractUploadArtifactSteps(yml: string): string[] {
  const stepStarts: number[] = [];
  const re = /\n( {2,10})- name:/g;
  let m;
  while ((m = re.exec(yml)) !== null) stepStarts.push(m.index + 1);
  stepStarts.push(yml.length);
  const steps: string[] = [];
  for (let i = 0; i < stepStarts.length - 1; i++) steps.push(yml.slice(stepStarts[i], stepStarts[i + 1]));
  return steps.filter((s) => /uses:\s*actions\/upload-artifact@/.test(s));
}

describe('dist/audit-reports/** artifact uploads tolerate the report-only 1-in-7 cadence (#6208)', () => {
  it('every upload-artifact step over dist/audit-reports/** sets if-no-files-found to ignore or warn, never error', () => {
    let matchingStepsFound = 0;
    for (const relPath of AUDIT_REPORTS_UPLOAD_WORKFLOWS) {
      const yml = readFileSync(resolve(ROOT, relPath), 'utf-8');
      const steps = extractUploadArtifactSteps(yml).filter((s) => /dist\/audit-reports/.test(s));
      for (const step of steps) {
        matchingStepsFound++;
        const nameMatch = step.match(/- name:\s*(.+)/);
        const stepName = nameMatch ? nameMatch[1].trim() : '(unnamed step)';
        const valueMatch = step.match(/if-no-files-found:\s*(\S+)/);
        // Field absent → GitHub defaults to `warn`, which is also safe.
        const value = valueMatch ? valueMatch[1] : 'warn';
        expect(
          value,
          `${relPath} — "${stepName}": if-no-files-found="${value}" would fail the job on the ` +
          `6-in-7 runs where the report-only cadence (#6202) skips writing dist/audit-reports/. ` +
          `Use "ignore" or "warn".`,
        ).not.toBe('error');
      }
    }
    expect(matchingStepsFound, 'expected at least one dist/audit-reports/** upload step across the checked workflows').toBeGreaterThan(0);
  });
});

describe('build-plugins/batchWrite.ts — flush concurrency', () => {
  it('default flush concurrency is tuned for CI SSD (≥ 500, ≤ 1024)', () => {
    // Catches accidental regressions like "concurrency = 200" sneaking back in.
    // Cap at ~1024 to avoid macOS launchd ulimit -n 256/1024 contention.
    const matches = BATCH_WRITE.match(/concurrency\s*=\s*(\d+)/g) || [];
    expect(matches.length, 'expected default-concurrency literals').toBeGreaterThan(0);
    for (const m of matches) {
      const n = Number(m.match(/(\d+)/)![1]);
      expect(n, `default concurrency literal "${m}" below tuned floor`).toBeGreaterThanOrEqual(500);
      expect(n, `default concurrency literal "${m}" above safe ceiling`).toBeLessThanOrEqual(1024);
    }
  });
});

/**
 * Guards for issue #2761 (follow-up of PR #2758's tar-pack rehydrate fast
 * path): the tar artifact fast path must not silently validate a
 * partial/corrupt shard with no fallback.
 *
 *   1) Producer side (deploy.yml): each "Pack ... shard dist (tar)" step
 *      must self-verify the tar's file count against the source directory
 *      it was packed from, so a future refactor that lets the two paths
 *      drift (or a tar bug) is caught instead of silently uploading a
 *      mismatched artifact.
 *   2) Consumer side (post-deploy-validate-dist.yml): after `tar xf ...`,
 *      the rehydrate loops must check EXTRACTION COMPLETENESS (tar's own
 *      listing count vs what actually landed on disk), not just
 *      `[ -d dist/$loc ]` existence — a truncated/corrupted tar can still
 *      create a partially-populated directory that passes a bare
 *      existence check with no fallback to the safe git-clone path.
 */
describe('deploy.yml + post-deploy-validate-dist.yml — tar-pack rehydrate fast path (#2761)', () => {
  it('every "Pack ... shard dist (tar)" step in deploy.yml self-verifies packed vs source file count', () => {
    const packSteps = DEPLOY_YML.match(/- name: Pack [^\n]*shard dist \(tar\)[^\n]*\n(?:.*\n)*?(?=\n {6}- name:|\n {4}- name:)/g) || [];
    expect(packSteps.length, 'expected at least the IT/non-IT Ticino + locale pack steps').toBeGreaterThanOrEqual(3);
    for (const step of packSteps) {
      expect(step, `pack step missing tar -tf listing count:\n${step}`).toMatch(/tar -tf .*\| \{ grep -vc '\/\$' \|\| true; \}/);
      expect(step, `pack step missing packed-vs-source file count comparison:\n${step}`).toMatch(/if \[ "\$packed_n" -ne "\$src_n" \]/);
      expect(step, `pack step must discard a mismatched tar (rm -f), not upload it:\n${step}`).toMatch(/rm -f "\$RUNNER_TEMP\/[^"]*\.tar"/);
    }
  });

  it('locale + section (Ticino/Svizzera/Zurigo) rehydrate loops check tar-extraction completeness, not just directory existence', () => {
    // The old (insufficient) guard was a bare existence check right after
    // `tar -C dist -xf ... || true`. Both loops must now compute an
    // `expected_n` from the tar's own listing BEFORE relying on the
    // extracted directory, and gate the "accept this tar" branch on
    // `actual_n` meeting `expected_n` — not merely on the directory existing.
    // Match EXACT, not "at least" (issue #6260): a tar that is itself
    // truncated stops `tar -tf`'s listing early, so `expected_n` undercounts
    // and `-ge` read the short extraction as complete. `-eq` is the only
    // comparison that catches drift in either direction, and this suite is
    // the THIRD place that pins the same line — the two per-script suites
    // are the other two — so it has to move with them or it pins the form
    // the fix just removed.
    // The section loop's tar filename is `$section-dist-$loc.tar` (a shell
    // variable, not a literal per-section name) since rehydrate_section()
    // covers ticino/svizzera/zurigo through the same code path.
    // locale rehydrate was extracted into scripts/lib/rehydrate-locale-shards.sh
    // and section rehydrate into scripts/lib/rehydrate-section-shards.sh
    // (section shared with the 4 seed-baseline workflows too, AGENTS.md #6
    // dedupe) — the guarded invariant is unchanged, only its file moved.
    const sources = [
      { label: 'locale-dist-\\$loc', text: REHYDRATE_LOCALE_SCRIPT },
      { label: '\\$section-dist-\\$loc', text: REHYDRATE_SECTION_SCRIPT },
    ];
    for (const { label, text } of sources) {
      const re = new RegExp(
        `expected_n=\\$\\(tar -tf "\\$dl/${label}\\.tar" 2>/dev/null \\| \\{ grep -vc '/\\$' \\|\\| true; \\}\\)[\\s\\S]*?` +
        `tar -C dist -xf "\\$dl/${label}\\.tar" \\|\\| true[\\s\\S]*?` +
        `if \\[ -d "dist/\\$(?:loc|sub)" \\] && \\[ "\\\$\\{expected_n:-0\\}" -gt 0 \\] && \\[ "\\$actual_n" -eq "\\$expected_n" \\]`,
      );
      expect(text, `rehydrate loop for "${label}" missing completeness gate (expected_n/actual_n)`).toMatch(re);
    }
    // The bare `if [ -d dist/$loc ]; then ... continue; fi` (no count check)
    // pattern from before the fix must not remain anywhere in the tar
    // extraction branches, in either file.
    for (const { text, name } of [
      { text: REHYDRATE_LOCALE_SCRIPT, name: 'rehydrate-locale-shards.sh' },
      { text: REHYDRATE_SECTION_SCRIPT, name: 'rehydrate-section-shards.sh' },
    ]) {
      expect(
        text,
        `${name}: a bare directory-existence-only accept branch survived post-tar-extract (regression of #2761 item 2)`,
      ).not.toMatch(/\|\| true\n\s*rm -rf "\$dl"\n\s*if \[ -d "dist\/\$(?:loc|sub)" \]; then\n\s*echo "rehydrated/);
    }
  });
});
