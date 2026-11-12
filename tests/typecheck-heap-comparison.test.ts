import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const gate = fs.readFileSync(path.join(ROOT, 'scripts/ci/check-typecheck-baseline.mjs'), 'utf8');
const comparison = fs.readFileSync(path.join(ROOT, 'scripts/ci/compare-typecheck-heap.sh'), 'utf8');
const contract = fs.readFileSync(path.join(ROOT, 'scripts/ci/typecheck-heap-contract.env'), 'utf8');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
const cgroupPeak = fs.readFileSync(path.join(ROOT, 'scripts/ci/run-with-cgroup-memory-peak.py'), 'utf8');
const comparisonWorkflow = fs.readFileSync(
  path.join(ROOT, '.github/workflows/typecheck-heap-comparison.yml'),
  'utf8',
);
const heapFlagPattern = /--max[-_]old[-_]space[-_]size\b/iu;

describe('typecheck heap comparison contract (#18199)', () => {
  it('lascia il limite heap al runner invece di sovrascriverlo nel processo figlio', () => {
    expect(gate).not.toMatch(heapFlagPattern);
    expect(gate).toContain('spawnSync(process.execPath, [TSC_BIN');
  });

  it('riconosce il flag heap con quoting, separatori e forme argomento diverse', () => {
    for (const form of [
      "'--max-old-space-size=12288'",
      '"--max-old-space-size 12288"',
      "'--max-old-space-size', '12288'",
      "'--max_old_space_size=12288'",
    ]) {
      expect(form).toMatch(heapFlagPattern);
    }
  });

  it('confronta old e new sullo stesso checkout con cache incrementale azzerata', () => {
    expect(contract).toContain('TYPECHECK_HISTORICAL_HEAP_MB=12288');
    expect(contract).toContain('TYPECHECK_CURRENT_HEAP_MB=10240');
    expect(comparison).toContain('source "$CONTRACT"');
    expect(comparison).toContain('OLD_HEAP_MB="$TYPECHECK_HISTORICAL_HEAP_MB"');
    expect(comparison).toContain('NEW_HEAP_MB="$TYPECHECK_CURRENT_HEAP_MB"');
    expect(comparison).toContain('rm -f "$BUILD_INFO"');
    expect(comparison.match(/npm run typecheck:gate/gu)).toHaveLength(1);
    expect(comparison).toContain('old_status');
    expect(comparison).toContain('new_status');
  });

  it('fallisce se una variante non passa o il nuovo peak cgroup raggiunge il limite runner', () => {
    expect(comparison).toContain('[ "$old_status" -ne 0 ] || [ "$new_status" -ne 0 ]');
    expect(comparison).toContain('[ "$new_peak_bytes" -ge "$runner_limit_bytes" ]');
    expect(cgroupPeak).toContain('memory.peak');
    expect(cgroupPeak).toContain('os.O_RDWR | os.O_CLOEXEC');
    expect(cgroupPeak).toContain('os.write(peak_fd, b"1")');
    expect(cgroupPeak).toContain('os.lseek(peak_fd, 0, os.SEEK_SET)');
    expect(cgroupPeak).toContain('/proc/meminfo');
    expect(cgroupPeak).toContain('memory.current');
  });

  it('mantiene il limite ordinario del workflow uguale al contratto misurato', () => {
    const configured = contract.match(/^TYPECHECK_CURRENT_HEAP_MB=(\d+)$/mu)?.[1];
    const wired = workflow.match(
      /NODE_OPTIONS=--max-old-space-size=(\d+)[\s\\]+\n\s+bash scripts\/ci\/sample-mem-during\.sh -- npm run typecheck:gate/u,
    )?.[1];
    expect(configured).toMatch(/^\d+$/u);
    expect(wired).toBe(configured);
  });

  it('attiva il confronto remoto per ogni modifica del contratto heap', () => {
    for (const watched of [
      '.github/workflows/tests.yml',
      '.github/workflows/typecheck-heap-comparison.yml',
      'scripts/ci/check-typecheck-baseline.mjs',
      'scripts/ci/compare-typecheck-heap.sh',
      'scripts/ci/run-with-cgroup-memory-peak.py',
      'scripts/ci/sample-mem-during.sh',
      'scripts/ci/typecheck-heap-contract.env',
      'tests/typecheck-heap-comparison.test.ts',
    ]) {
      expect(comparisonWorkflow).toContain(`- '${watched}'`);
    }
    expect(comparisonWorkflow).toContain('runs-on: ubuntu-latest');
    expect(comparisonWorkflow).toContain(
      'run: npx vitest run tests/typecheck-heap-comparison.test.ts --reporter=dot',
    );
    expect(comparisonWorkflow).toContain('run: bash scripts/ci/compare-typecheck-heap.sh');
  });

  it('fallisce chiuso se il contatore memory.peak non è scrivibile per il reset', () => {
    if (process.platform !== 'linux' || process.getuid?.() === 0) return;

    const cgroupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-heap-cgroup-'));
    const peakFile = path.join(cgroupDir, 'memory.peak');
    fs.writeFileSync(path.join(cgroupDir, 'memory.current'), '1048576\n');
    fs.writeFileSync(path.join(cgroupDir, 'memory.max'), '104857600\n');
    fs.writeFileSync(peakFile, '1048576\n');
    fs.chmodSync(peakFile, 0o444);

    try {
      const result = spawnSync(
        'python3',
        [
          path.join(ROOT, 'scripts/ci/run-with-cgroup-memory-peak.py'),
          '--test-cgroup-dir',
          cgroupDir,
          '--',
          'true',
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('richiede accesso privilegiato per il reset');
    } finally {
      fs.rmSync(cgroupDir, { recursive: true, force: true });
    }
  });

  it('misura il cgroup del job e applica il limite memory.max dell’antenato', () => {
    if (process.platform !== 'linux') return;

    const mountDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-heap-cgroup-'));
    const jobDir = path.join(mountDir, 'job');
    fs.mkdirSync(jobDir);
    fs.writeFileSync(path.join(mountDir, 'memory.current'), '524288\n');
    fs.writeFileSync(path.join(mountDir, 'memory.max'), '100000000\n');
    fs.writeFileSync(path.join(mountDir, 'memory.peak'), '524288\n');
    fs.writeFileSync(path.join(jobDir, 'memory.current'), '1048576\n');
    fs.writeFileSync(path.join(jobDir, 'memory.max'), 'max\n');
    fs.writeFileSync(path.join(jobDir, 'memory.peak'), '1048576\n');

    try {
      const result = spawnSync(
        'python3',
        [
          path.join(ROOT, 'scripts/ci/run-with-cgroup-memory-peak.py'),
          '--test-cgroup-dir',
          jobDir,
          '--test-cgroup-mount',
          mountDir,
          '--',
          'true',
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      const output = (result.stdout ?? '') + (result.stderr ?? '');

      expect(result.status, output).toBe(0);
      expect(output).toContain('baseline_cgroup_memory_bytes=1048576');
      expect(output).toContain('peak_cgroup_memory_bytes=1048576');
      expect(output).toContain('runner_limit_bytes=100000000');
    } finally {
      fs.rmSync(mountDir, { recursive: true, force: true });
    }
  });

  it('rifiuta un valore peak cgroup malformato', () => {
    if (process.platform !== 'linux') return;

    const cgroupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-heap-cgroup-'));
    fs.writeFileSync(path.join(cgroupDir, 'memory.current'), '1048576\n');
    fs.writeFileSync(path.join(cgroupDir, 'memory.max'), '104857600\n');
    fs.writeFileSync(path.join(cgroupDir, 'memory.peak'), '1048576\n');

    try {
      const result = spawnSync(
        'python3',
        [
          path.join(ROOT, 'scripts/ci/run-with-cgroup-memory-peak.py'),
          '--test-cgroup-dir',
          cgroupDir,
          '--',
          'python3',
          '-c',
          'import pathlib, sys; pathlib.Path(sys.argv[1]).write_text("invalid")',
          path.join(cgroupDir, 'memory.peak'),
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('peak cgroup non valido');
    } finally {
      fs.rmSync(cgroupDir, { recursive: true, force: true });
    }
  });

  it(
    'retains a transient memory spike that occurs between five-second VmRSS samples',
    () => {
      if (process.platform !== 'linux') return;

      const spike = [
        'import mmap, os, time',
        'assert os.getuid() == int(os.environ.get("SUDO_UID", os.getuid()))',
        'time.sleep(1.0)',
        'size = 256 * 1024 * 1024',
        'mapping = mmap.mmap(-1, size)',
        'for offset in range(0, size, 4096): mapping[offset] = 1',
        'time.sleep(0.25)',
        'mapping.close()',
        'time.sleep(5.2)',
      ].join('\n');
      const result = spawnSync(
        'python3',
        [
          path.join(ROOT, 'scripts/ci/run-with-cgroup-memory-peak.py'),
          '--',
          'bash',
          path.join(ROOT, 'scripts/ci/sample-mem-during.sh'),
          '--',
          'python3',
          '-c',
          spike,
        ],
        { encoding: 'utf8', timeout: 15000 },
      );
      const output = (result.stdout ?? '') + (result.stderr ?? '');
      const peakDeltaBytes = Number(output.match(/peak_delta_bytes=(\d+)/u)?.[1]);
      const sampledPeakMb = Number(output.match(/peak_rss_mb=(\d+)MB/u)?.[1]);

      expect(result.error).toBeUndefined();
      expect(result.status, `cgroup helper output:\n${output}`).toBe(0);
      expect(peakDeltaBytes).toBeGreaterThanOrEqual(192 * 1024 * 1024);
      expect(sampledPeakMb).toBeLessThan(128);
    },
    15000,
  );
});
