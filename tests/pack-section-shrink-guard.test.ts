import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';

// Guard for issue #6283 (follow-up of PR #6263): deploy.yml's pack_section()
// byte-identity guard compares packed_n against the live source count from
// the same directory push-section-shard.sh already staged. The independent
// baseline at $RUNNER_TEMP/shard-srcn-<section>-<loc> is compared BEFORE
// packing, so a shrink between the push and pack steps is still caught.

const ROOT = resolve(import.meta.dirname, '..');
const PUBLISHER_YML = readFileSync(resolve(ROOT, '.github/workflows/deploy-publish.yml'), 'utf-8');
const IT_GROUP_HELPER = readFileSync(resolve(ROOT, 'scripts/ci/push-it-shard-group.sh'), 'utf-8');
const PUSH_SECTION_SHARD_SH = readFileSync(resolve(ROOT, 'scripts/lib/push-section-shard.sh'), 'utf-8');

function extractPackSectionFns(yml: string): string[] {
  const matches = yml.match(/pack_section\(\) \{[\s\S]*?rm -rf "\$src"\n\s*\}/g) || [];
  return matches;
}

function extractItPackSnippet(): string {
  const start = IT_GROUP_HELPER.indexOf('  live_src_n="$(find "$stage/$slug" -type f');
  const end = IT_GROUP_HELPER.indexOf('  node scripts/ci/shard-content-manifest.mjs create-section', start);
  if (start < 0 || end < 0) throw new Error('IT pack snippet boundary not found');
  return IT_GROUP_HELPER.slice(start, end);
}

describe('scripts/lib/push-section-shard.sh — persists an independent src_n baseline', () => {
  it('writes $RUNNER_TEMP/shard-srcn-<section>-<locale> right after computing src_n from the staged tree', () => {
    expect(PUSH_SECTION_SHARD_SH).toMatch(
      // #9070 moved the count behind shard_count_files (NUL-safe); either form
      // still persists the baseline on the very next line.
      /src_n="\$\((?:find "\$stage_src\/dist\/\$sub" -type f \| wc -l|shard_count_files "\$stage_src\/dist\/\$sub")\)"\n\s*printf '%s' "\$src_n" > "\$RUNNER_TEMP\/shard-srcn-\$section-\$loc"/,
    );
  });
});

describe('publisher pack paths — independent shrink guard (issue #6283)', () => {
  const nonItFns = extractPackSectionFns(PUBLISHER_YML);

  it('keeps one inline non-IT packer and the IT group helper packer', () => {
    expect(nonItFns.length).toBe(1);
    expect(IT_GROUP_HELPER).toContain('persisted_src_n="$(cat "$source_count_file")"');
    expect(IT_GROUP_HELPER).toContain('if [[ "$live_src_n" != "$persisted_src_n" ]]');
    expect(IT_GROUP_HELPER).toContain('tar -C "$stage" -cf "$tar_path" "$slug"');
  });

  it('both pack paths compare the LIVE count against the persisted baseline BEFORE creating the tar', () => {
    for (const fn of nonItFns) {
      const shrinkCheckIdx = fn.search(/if \[ "\$live_src_n" -ne "\$persisted_src_n" \]/);
      const tarCreateIdx = fn.search(/tar -C "\$src" -cvf/);
      expect(shrinkCheckIdx, `missing independent shrink check:\n${fn}`).toBeGreaterThan(-1);
      expect(tarCreateIdx, `missing tar creation:\n${fn}`).toBeGreaterThan(-1);
      expect(shrinkCheckIdx, 'shrink check must run BEFORE the tar is created').toBeLessThan(tarCreateIdx);
    }
    expect(IT_GROUP_HELPER.indexOf('if [[ "$live_src_n" != "$persisted_src_n" ]]'))
      .toBeLessThan(IT_GROUP_HELPER.indexOf('tar -C "$stage" -cf "$tar_path" "$slug"'));
  });

  it('walks the source once and counts tar members from tar -cvf output without masking tar failures', () => {
    for (const fn of nonItFns) {
      expect(fn.match(/find "\$src\/\$sub" -type f \| wc -l/g)).toHaveLength(1);
      expect(fn).toMatch(/if ! packed_n=\$\(tar -C "\$src" -cvf[\s\S]*\| awk '!\/\\\/\$\/ \{ n\+\+ \} END \{ print n \+ 0 \}'\); then[\s\S]*rm -f "\$RUNNER_TEMP\/[^\"]+\.tar"[\s\S]*return 0/);
      expect(fn).not.toMatch(/tar -C "\$src" -cvf[\s\S]*\|[^\n]*\|\| true/);
      expect(fn).not.toContain('tar -tf');
      expect(fn).toContain('if [ "$packed_n" -ne "$live_src_n" ]');
    }
  });

  it('a mismatch skips the pack (return 0, no tar) exactly like the "no ok-marker" path', () => {
    for (const fn of nonItFns) {
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

  function runItPackSection(shrink: boolean): { tarPath: string; output: string } {
    const runnerTemp = mkdtempSync(join(tmpdir(), 'pack-it-section-shrink-'));
    tmpDirs.push(runnerTemp);
    const section = 'ticino';
    const slug = 'cerca-lavoro-ticino';
    const stage = join(runnerTemp, `${section}-src-it`, 'dist');
    const stagedSection = join(stage, slug);
    mkdirSync(stagedSection, { recursive: true });
    for (let i = 1; i <= 20; i++) writeFileSync(join(stagedSection, `p${i}.html`), 'x');
    writeFileSync(join(runnerTemp, `shard-srcn-${section}-it`), '20');
    if (shrink) {
      for (let i = 10; i <= 19; i++) rmSync(join(stagedSection, `p${i}.html`));
    }
    const tarPath = join(runnerTemp, `${section}-dist-it.tar`);
    const script = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `export RUNNER_TEMP=${JSON.stringify(runnerTemp)}`,
      'fail=0',
      `slug=${JSON.stringify(slug)}`,
      `stage=${JSON.stringify(stage)}`,
      'while IFS= read -r section; do',
      extractItPackSnippet(),
      '  break',
      'done <<< ticino',
      'exit "$fail"',
    ].join('\n');
    const scriptPath = join(runnerTemp, 'run-it-pack.sh');
    writeFileSync(scriptPath, script);
    let output = '';
    try {
      output = execFileSync('bash', [scriptPath], { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: unknown) {
      const error = e as { stdout?: Buffer | string; stderr?: Buffer | string };
      output = `${error.stdout?.toString() ?? ''}${error.stderr?.toString() ?? ''}`;
    }
    return { tarPath, output };
  }

  it('IT publisher refuses to pack when the staged tree shrank after push-section-shard.sh persisted its count', () => {
    const { tarPath, output } = runItPackSection(true);
    expect(existsSync(tarPath), 'a shrunk-but-internally-consistent tree must NOT produce a tar').toBe(false);
    expect(output).toContain('subtree shrank between push and pack');
  });

  it('IT publisher packs the exact staged count when the independent baseline still matches', () => {
    const { tarPath } = runItPackSection(false);
    expect(existsSync(tarPath)).toBe(true);
    const members = execFileSync('tar', ['-tf', tarPath], { encoding: 'utf8' })
      .split('\n').filter((member) => member && !member.endsWith('/'));
    expect(members).toHaveLength(20);
  });

  it('non-IT-leg: refuses to pack when the staged tree shrank after push-section-shard.sh persisted its count', () => {
    const [nonItFn] = extractPackSectionFns(PUBLISHER_YML);
    const { tarExists } = runPackSection(nonItFn, { loc: 'en', setLocVar: true });
    expect(tarExists, 'a shrunk-but-internally-consistent tree must NOT produce a tar').toBe(false);
  });
});
