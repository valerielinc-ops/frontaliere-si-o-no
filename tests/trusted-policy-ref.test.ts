import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

/**
 * `github.event.pull_request.base.sha` è il commit di main da cui la PR è
 * PARTITA, non la policy che main applica oggi. Se main aggiunge un modulo del
 * gate dopo l'apertura della PR, quel ref non ce l'ha: `contents/<path>?ref=`
 * risponde 404, il download muore e il verdetto che arriva all'autore è
 * «required review gate skipped» — un rosso che non nomina né il file né il
 * ref. Misurato sul corpus (PR #1599) e riprodotto su questo repo
 * (run 35472199618). Questi test pinnano le due proprietà: l'ancoraggio alla
 * punta di main pinnata, e un errore che dice cosa manca e dove.
 */
const raw = readFileSync('.github/workflows/tests.yml', 'utf8');
const workflow = YAML.parse(raw);

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string> };

function steps(): Step[] {
  return Object.values(workflow.jobs as Record<string, { steps?: Step[] }>)
    .flatMap((job) => job.steps ?? []);
}

function downloaders(): Step[] {
  return steps().filter((step) => String(step.run ?? '').includes('download_main'));
}

describe('ref della policy fidata', () => {
  it('nessuno step della policy si ancora a base.sha', () => {
    const anchored = downloaders()
      .filter((step) => String((step.env ?? {}).POLICY_REF ?? '').includes('pull_request.base.sha'))
      .map((step) => step.id ?? step.name);
    expect(anchored, `step ancora su base.sha: ${anchored.join(', ')}`).toEqual([]);
  });

  it('ogni downloader usa lo SHA risolto una volta sola', () => {
    const all = downloaders();
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const step of all) {
      expect(String((step.env ?? {}).POLICY_REF ?? ''), `POLICY_REF di ${step.id ?? step.name}`)
        .toContain('steps.policy_ref.outputs.sha');
    }
  });

  it('il resolver esiste, pinna uno SHA a 40 cifre e non ripiega su base.sha', () => {
    const resolver = steps().find((step) => step.id === 'policy_ref');
    expect(resolver).toBeTruthy();
    const run = String(resolver!.run);
    expect(run).toContain('commits/main');
    expect(run).toMatch(/\[0-9a-f\]\{40\}/u);
    expect(run).toContain('printf \'sha=%s\\n\'');
    // Un ripiego su base.sha rimetterebbe in gioco la policy incompleta.
    expect(run).not.toMatch(/policy_ref="?\$\{?FALLBACK_REF/u);
  });

  it('il resolver gira prima di ogni downloader', () => {
    const order = steps();
    const resolver = order.findIndex((step) => step.id === 'policy_ref');
    const firstDownloader = order.findIndex((step) => String(step.run ?? '').includes('download_main'));
    expect(resolver).toBeGreaterThan(-1);
    expect(resolver).toBeLessThan(firstDownloader);
  });

  it('ogni download fallito nomina il file e il ref', () => {
    for (const step of downloaders()) {
      const run = String(step.run);
      expect(run, `messaggio di errore in ${step.id ?? step.name}`)
        .toContain("non scaricabile da main@${POLICY_REF}");
      expect(run).toContain("'${path}'");
    }
  });
});

describe('comportamento reale del downloader su un file assente', () => {
  function downloadMainScript(): string {
    // Estrae il corpo della funzione dal workflow e lo esegue con un `gh`
    // finto: il test non deve fidarsi della lettura, deve vedere l'effetto.
    const step = steps().find((candidate) => candidate.id === 'review_policy');
    const run = String(step?.run ?? '');
    // YAML strippa l'indentazione del blocco `run: |`, quindi qui la funzione
    // è già a colonna 0 e si chiude su una riga `}` nuda.
    const open = run.indexOf('download_main() {');
    const close = run.indexOf('\n}', open);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    return run.slice(open, close + 2);
  }

  it('esce non-zero, nomina path e ref, e non lascia un file mutilato', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-ref-'));
    const fakeGh = join(dir, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\necho "gh: Not Found (HTTP 404)" >&2\nexit 1\n');
    chmodSync(fakeGh, 0o755);
    const script = join(dir, 'run.sh');
    writeFileSync(script, [
      'set -uo pipefail',
      'GITHUB_REPOSITORY=owner/repo',
      `TRUSTED_GH_BIN="${fakeGh}"`,
      'POLICY_REF=' + 'a'.repeat(40),
      downloadMainScript(),
      `download_main scripts/ci/nuovo-modulo.mjs "${join(dir, 'out.mjs')}"`,
    ].join('\n'));

    let status = 0;
    let output = '';
    try {
      output = execFileSync('bash', [script], { encoding: 'utf8' });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      status = failure.status ?? 1;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    expect(status).not.toBe(0);
    expect(output).toContain('scripts/ci/nuovo-modulo.mjs');
    expect(output).toContain(`main@${'a'.repeat(40)}`);
    expect(output).toContain('404');
    // Il file parziale e il suo scratch non restano in giro a far credere che
    // il download sia andato.
    expect(() => readFileSync(join(dir, 'out.mjs'), 'utf8')).toThrow();
    expect(() => readFileSync(join(dir, 'out.mjs.err'), 'utf8')).toThrow();
  });
});
