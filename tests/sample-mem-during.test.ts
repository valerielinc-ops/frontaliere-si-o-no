import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/ci/sample-mem-during.sh');

function makeMeminfo(dir: string, memAvailableMb: number) {
  const file = path.join(dir, 'meminfo');
  fs.writeFileSync(file, `MemTotal:       16000000 kB\nMemAvailable:   ${memAvailableMb * 1024} kB\n`);
  return file;
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('sample-mem-during.sh', () => {
  it('propaga l\'exit code del comando osservato (successo)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-mem-'));
    try {
      const meminfo = makeMeminfo(tmp, 12000);
      const result = run(['--', 'bash', '-c', 'sleep 0.3; exit 0'], {
        SAMPLE_MEM_DURING_MEMINFO: meminfo,
        SAMPLE_MEM_DURING_INTERVAL_S: '0.1',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/\[mem-sample\] MemAvailable min=\d+MB max=\d+MB samples=\d+/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('propaga l\'exit code del comando osservato (fallimento)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-mem-'));
    try {
      const meminfo = makeMeminfo(tmp, 12000);
      const result = run(['--', 'bash', '-c', 'exit 7'], {
        SAMPLE_MEM_DURING_MEMINFO: meminfo,
        SAMPLE_MEM_DURING_INTERVAL_S: '0.1',
      });
      expect(result.status).toBe(7);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('termina in fretta su un fallimento rapido anche con un intervallo enorme (no timer fisso)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-mem-'));
    try {
      const meminfo = makeMeminfo(tmp, 12000);
      const start = Date.now();
      const result = run(['--', 'bash', '-c', 'exit 1'], {
        SAMPLE_MEM_DURING_MEMINFO: meminfo,
        // Un vecchio bug (kill -0 su zombie) restava appeso qui: un
        // intervallo enorme deve comunque tornare in pochi secondi, non
        // aspettare l'intervallo intero. Regression guard diretta.
        SAMPLE_MEM_DURING_INTERVAL_S: '300',
      });
      const elapsedMs = Date.now() - start;
      expect(result.status).toBe(1);
      // Il sampler puo' fare in tempo a raccogliere il primo campione (parte
      // in parallelo al comando), quindi il test rilevante non e' "zero
      // campioni" ma "non e' rimasto appeso per l'intervallo intero".
      expect(elapsedMs).toBeLessThan(5000);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('riporta min/max coerenti su piu\' campioni', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-mem-'));
    try {
      const meminfo = makeMeminfo(tmp, 9000);
      const result = run(['--', 'bash', '-c', 'sleep 0.5; exit 0'], {
        SAMPLE_MEM_DURING_MEMINFO: meminfo,
        SAMPLE_MEM_DURING_INTERVAL_S: '0.1',
      });
      expect(result.status).toBe(0);
      const match = /min=(\d+)MB max=(\d+)MB samples=(\d+)/.exec(result.stdout);
      expect(match).not.toBeNull();
      const [, minMb, maxMb, samples] = match!;
      expect(Number(minMb)).toBe(9000);
      expect(Number(maxMb)).toBe(9000);
      expect(Number(samples)).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('spegne il sampler quando /proc/meminfo non e\' leggibile, ma esegue comunque il comando', () => {
    const result = run(['--', 'bash', '-c', 'exit 0'], {
      SAMPLE_MEM_DURING_MEMINFO: '/nonexistent/meminfo-path',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('sampler spento');
    expect(result.stdout).toContain('nessun campione raccolto');
  });

  it('senza comando fallisce loud con exit 2', () => {
    const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('uso:');
  });

  it('non lascia processi orfani dietro al sampler', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-mem-'));
    try {
      const meminfo = makeMeminfo(tmp, 12000);
      const before = spawnSync('pgrep', ['-f', 'sample-mem-during'], { encoding: 'utf8' }).stdout
        .split('\n')
        .filter(Boolean).length;
      run(['--', 'bash', '-c', 'sleep 0.3; exit 0'], {
        SAMPLE_MEM_DURING_MEMINFO: meminfo,
        SAMPLE_MEM_DURING_INTERVAL_S: '0.1',
      });
      const after = spawnSync('pgrep', ['-f', 'sample-mem-during'], { encoding: 'utf8' }).stdout
        .split('\n')
        .filter(Boolean).length;
      expect(after).toBeLessThanOrEqual(before);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
