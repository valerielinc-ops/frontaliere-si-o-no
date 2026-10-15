/**
 * Osservatore della classe «override d'ambiente che redirige una SCRITTURA il
 * cui default e' un file TRACCIATO, onorato in silenzio» (issue #7291, item 2).
 *
 * La regressione da impedire non e' un output sbagliato: e' un output che
 * finisce altrove senza che nulla lo dica. `scripts/load-rc-env.mjs` inietta
 * chiavi nell'environment del cron, e un `export` residuo in una shell fa lo
 * stesso; se l'override passa inosservato, il job resta verde mentre il file
 * consumato dal build non si muove.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOutputPath, describePath, allowInCiVar } from '../scripts/lib/resolve-output-path.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function capture() {
  const log: string[] = [];
  const warn: string[] = [];
  return { log, warn, sinks: { log: (m: string) => log.push(m), warn: (m: string) => warn.push(m) } };
}

const base = {
  label: 'demo',
  envVar: 'DEMO_OUT',
  canonicalPath: path.join('data', 'demo.json'),
  root: ROOT,
};

describe('resolveOutputPath', () => {
  it('senza override risolve il percorso canonico e lo logga comunque', () => {
    const c = capture();
    const out = resolveOutputPath({ ...base, env: {}, ...c.sinks });
    expect(out).toBe(path.join(ROOT, 'data', 'demo.json'));
    expect(c.log.join('\n')).toContain('data/demo.json');
    expect(c.warn).toHaveLength(0);
  });

  it('fuori da CI onora l\'override e lo dichiara nel log', () => {
    const c = capture();
    const out = resolveOutputPath({ ...base, env: { DEMO_OUT: '/tmp/demo-out.json' }, ...c.sinks });
    expect(out).toBe('/tmp/demo-out.json');
    const line = c.log.join('\n');
    expect(line).toContain('REDIRETTO');
    expect(line).toContain('DEMO_OUT');
    expect(line).toContain('/tmp/demo-out.json');
    // Il percorso canonico compare comunque, cosi' si legge cosa NON viene scritto.
    expect(line).toContain('data/demo.json');
  });

  it('in CI senza opt-in IGNORA l\'override e avvisa', () => {
    const c = capture();
    const out = resolveOutputPath({ ...base, env: { CI: 'true', DEMO_OUT: '/tmp/demo-out.json' }, ...c.sinks });
    expect(out).toBe(path.join(ROOT, 'data', 'demo.json'));
    expect(c.warn.join('\n')).toContain('IGNORATO in CI');
    expect(c.warn.join('\n')).toContain(allowInCiVar('DEMO_OUT'));
  });

  it('in CI con opt-in esplicito onora l\'override', () => {
    const c = capture();
    const out = resolveOutputPath({
      ...base,
      env: { CI: 'true', DEMO_OUT: '/tmp/demo-out.json', DEMO_OUT_ALLOW_CI: '1' },
      ...c.sinks,
    });
    expect(out).toBe('/tmp/demo-out.json');
    expect(c.warn).toHaveLength(0);
  });

  it('un override vuoto o solo spazi non e\' un override', () => {
    const c = capture();
    expect(resolveOutputPath({ ...base, env: { DEMO_OUT: '   ' }, ...c.sinks }))
      .toBe(path.join(ROOT, 'data', 'demo.json'));
  });

  it('describePath resta relativo dentro il repo e assoluto fuori', () => {
    expect(describePath(ROOT, path.join(ROOT, 'data', 'x.json'))).toBe(path.join('data', 'x.json'));
    expect(describePath(ROOT, '/tmp/x.json')).toBe('/tmp/x.json');
  });
});

describe('cluster-orphan-queries.mjs logga sempre il percorso risolto', () => {
  // `--dry-run` non scrive niente: il caso puo' esercitare il ramo
  // CI-senza-opt-in senza rischiare di toccare il file tracciato che verifica.
  const redirect = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-out-')), 'out.json');

  function run(env: Record<string, string>) {
    const r = spawnSync('node', ['scripts/cluster-orphan-queries.mjs', '--dry-run'], {
      cwd: ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CI: 'true',
        GSC_ORPHAN_CLUSTERS_OUT: '',
        GSC_ORPHAN_CLUSTERS_OUT_ALLOW_CI: '',
        ...env,
      },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    return `${r.stdout}\n${r.stderr}`;
  }

  it('in CI senza opt-in la redirezione e\' rifiutata a voce alta, non silenziosa', () => {
    const out = run({ GSC_ORPHAN_CLUSTERS_OUT: redirect });
    expect(out).toContain('IGNORATO in CI');
    expect(out).toContain('GSC_ORPHAN_CLUSTERS_OUT_ALLOW_CI');
    expect(out).toContain('data/gsc-orphan-queries-clusters.json');
    expect(fs.existsSync(redirect)).toBe(false);
  });

  it('con opt-in dichiara la redirezione nel log', () => {
    const out = run({ GSC_ORPHAN_CLUSTERS_OUT: redirect, GSC_ORPHAN_CLUSTERS_OUT_ALLOW_CI: '1' });
    expect(out).toContain('REDIRETTO');
    expect(out).toContain('GSC_ORPHAN_CLUSTERS_OUT');
    expect(out).toContain(redirect);
  });

  it('senza override il percorso canonico e\' comunque a log', () => {
    expect(run({})).toContain('data/gsc-orphan-queries-clusters.json');
  });
});
