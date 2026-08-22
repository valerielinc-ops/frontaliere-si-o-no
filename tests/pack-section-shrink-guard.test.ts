import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';

// Guard for issue #6283 (follow-up of PR #6263): deploy.yml's pack_section()
// byte-identity guard compares packed_n against a src_n RECOMPUTED at pack
// time from the same directory push-section-shard.sh already staged — if
// that directory shrinks between the push step and this later pack step,
// both counts derive from the already-shrunk tree and agree, so the guard
// is structurally blind to the shrink. push-section-shard.sh now persists
// the file count it saw right after staging ($RUNNER_TEMP/shard-srcn-<section>-<loc>),
// and pack_section() compares the LIVE count against that independent,
// earlier baseline BEFORE packing — this is the guard that is actually able
// to catch the shrink.

const ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_YML = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf-8');
const PUSH_SECTION_SHARD_SH = readFileSync(resolve(ROOT, 'scripts/lib/push-section-shard.sh'), 'utf-8');

function extractPackSectionFns(yml: string): string[] {
  const matches = yml.match(/pack_section\(\) \{[\s\S]*?rm -rf "\$src"\n\s*\}/g) || [];
  return matches;
}

describe('scripts/lib/push-section-shard.sh — persists an independent src_n baseline', () => {
  it('writes $RUNNER_TEMP/shard-srcn-<section>-<locale> right after computing src_n from the staged tree', () => {
    expect(PUSH_SECTION_SHARD_SH).toMatch(
      /src_n="\$\(find "\$stage_src\/dist\/\$sub" -type f \| wc -l\)"\n\s*printf '%s' "\$src_n" > "\$RUNNER_TEMP\/shard-srcn-\$section-\$loc"/,
    );
  });
});

describe('deploy.yml pack_section() — independent shrink guard (issue #6283)', () => {
  const fns = extractPackSectionFns(DEPLOY_YML);

  it('both the IT-leg and non-IT-leg pack_section() blocks exist', () => {
    expect(fns.length).toBe(2);
  });

  it('both blocks compare the LIVE count against the persisted baseline BEFORE creating the tar', () => {
    for (const fn of fns) {
      const shrinkCheckIdx = fn.search(/if \[ "\$live_src_n" -ne "\$persisted_src_n" \]/);
      const tarCreateIdx = fn.search(/tar -C "\$src" -cf/);
      expect(shrinkCheckIdx, `missing independent shrink check:\n${fn}`).toBeGreaterThan(-1);
      expect(tarCreateIdx, `missing tar creation:\n${fn}`).toBeGreaterThan(-1);
      expect(shrinkCheckIdx, 'shrink check must run BEFORE the tar is created').toBeLessThan(tarCreateIdx);
    }
  });

  it('a mismatch skips the pack (return 0, no tar) exactly like the "no ok-marker" path', () => {
    for (const fn of fns) {
      expect(fn).toMatch(/persisted src_n=\$persisted_src_n, live=\$live_src_n\).*\n\s*return 0/);
    }
  });

  // Functional reproduction of the Scheda COMANDO (issue #6283): stage a tree,
  // persist its count, shrink it (simulating the race between
  // push-section-shard.sh and the later pack step), then run the REAL
  // extracted pack_section() body and assert it refuses to produce a tar.
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  function runPackSection(fnBody: string, opts: { loc: string; setLocVar: boolean }): { tarExists: boolean; stderr: string } {
    const runnerTemp = mkdtempSync(join(tmpdir(), 'pack-section-shrink-'));
    tmpDirs.push(runnerTemp);
    const section = 'ticino';
    const sub = opts.loc === 'it' ? 'cerca-lavoro-ticino' : `${opts.loc}/find-jobs-ticino`;
    const srcDir = join(runnerTemp, `${section}-src-${opts.loc}`, 'dist', sub);
    mkdirSync(srcDir, { recursive: true });
    for (let i = 1; i <= 20; i++) writeFileSync(join(srcDir, `p${i}.html`), 'x');
    // What push-section-shard.sh does: persist the count seen at staging time.
    writeFileSync(join(runnerTemp, `shard-srcn-${section}-${opts.loc}`), '20');
    writeFileSync(join(runnerTemp, `shard-ok-${section}-${opts.loc}`), '');
    // Simulate the shrink between push and pack (the race #6263 observed).
    for (let i = 10; i <= 19; i++) rmSync(join(srcDir, `p${i}.html`));

    const script = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `export RUNNER_TEMP=${JSON.stringify(runnerTemp)}`,
      `export ${section.toUpperCase()}_SHARD_LIVE=true`,
      opts.setLocVar ? `loc=${JSON.stringify(opts.loc)}` : '',
      fnBody,
      `pack_section ${section}`,
    ].join('\n');
    const scriptPath = join(runnerTemp, 'run.sh');
    writeFileSync(scriptPath, script);
    let stderr = '';
    try {
      execFileSync('bash', [scriptPath], { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: unknown) {
      stderr = (e as { stderr?: string }).stderr ?? '';
    }
    const tarName = opts.loc === 'it' ? `${section}-dist-it.tar` : `${section}-dist-${opts.loc}.tar`;
    return { tarExists: existsSync(join(runnerTemp, tarName)), stderr };
  }

  it('IT-leg: refuses to pack when the staged tree shrank after push-section-shard.sh persisted its count', () => {
    const [itFn] = extractPackSectionFns(DEPLOY_YML);
    const { tarExists } = runPackSection(itFn, { loc: 'it', setLocVar: false });
    expect(tarExists, 'a shrunk-but-internally-consistent tree must NOT produce a tar').toBe(false);
  });

  it('non-IT-leg: refuses to pack when the staged tree shrank after push-section-shard.sh persisted its count', () => {
    const [, nonItFn] = extractPackSectionFns(DEPLOY_YML);
    const { tarExists } = runPackSection(nonItFn, { loc: 'en', setLocVar: true });
    expect(tarExists, 'a shrunk-but-internally-consistent tree must NOT produce a tar').toBe(false);
  });
});
