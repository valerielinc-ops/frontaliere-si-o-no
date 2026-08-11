import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Il wiring del gate di factuality dentro `sync-articles-sitemaps.yml`
 * (issue #5595, parte 2/2).
 *
 * Il difetto riparato non era il gate — `scripts/lib/article-factuality-gates.mjs`
 * e' deterministico e segnala correttamente l'articolo citato nell'issue — ma
 * il fatto che nessuno lo eseguisse sul percorso che pubblica. Dal cutover
 * 2026-08-02 (#4974) i body arrivano dal corpus e questo job li committa
 * **direttamente su `main`, senza PR**, quindi:
 *
 *   - la run `pull_request` di `tests.yml` non li vede mai;
 *   - la run `push: branches: [main]` non parte nemmeno, perche' il push usa il
 *     `GITHUB_TOKEN` del workflow e GitHub non innesca workflow su quei push
 *     (misurato 2026-08-11: il commit di sync 7f1a3b4f ha 4 check-run, tutte
 *     `schedule`/`workflow_run`, zero `push`);
 *   - e se partisse, su un push `github.base_ref` e' vuoto e il gate diffa
 *     `origin/main` con se stesso: scope vuoto, verde, niente verificato.
 *
 * Restano due sole proprieta' da difendere, ed entrambe sono invisibili a
 * review: che lo step stia PRIMA del commit (dopo, il diff non esiste piu') e
 * che non possa fermare la pubblicazione.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'sync-articles-sitemaps.yml');
const REPORTER = 'scripts/ci/report-synced-article-factuality.mjs';

type Step = { name?: string; id?: string; if?: string; run?: string; 'continue-on-error'?: boolean };

const doc = parseYaml(fs.readFileSync(WORKFLOW, 'utf-8')) as {
  permissions: Record<string, string>;
  jobs: { sync: { steps: Step[] } };
};
const steps = doc.jobs.sync.steps;
const indexOfName = (fragment: string) => steps.findIndex((s) => s.name?.includes(fragment));

describe('sync-articles-sitemaps.yml: il gate di factuality e` collegato al punto giusto', () => {
  it('invoca il reporter', () => {
    const i = indexOfName('Report factuality');
    expect(i, 'lo step manca: il gate tornerebbe a non girare su nessun articolo pubblicato').toBeGreaterThan(-1);
    expect(steps[i].run).toContain(REPORTER);
  });

  it('gira PRIMA del commit, che e` l`unico momento in cui il diff esiste', () => {
    // Dopo il commit `git diff` e` pulito e `--changed-worktree` non vedrebbe
    // piu` niente: lo step resterebbe verde verificando zero articoli — la
    // stessa forma di gate vacuo che questa issue ripara.
    const report = indexOfName('Report factuality');
    const commit = indexOfName('Commit if changed');
    expect(commit).toBeGreaterThan(-1);
    expect(report).toBeLessThan(commit);
  });

  it('gira DOPO il pull del corpus, altrimenti giudicherebbe l`albero vecchio', () => {
    expect(indexOfName('Report factuality')).toBeGreaterThan(indexOfName('Pull the article corpus'));
  });

  it('non puo` fermare la pubblicazione', () => {
    // Un rosso qui terrebbe indietro l'intero batch — articoli corretti
    // compresi — piu` le sitemap, i dieci feed RSS e il ticker che viaggiano
    // sullo stesso commit. Il passaggio a bloccante e` una decisione del
    // proprietario, non un effetto collaterale di un refactor del workflow.
    const step = steps[indexOfName('Report factuality')];
    expect(step['continue-on-error']).toBe(true);
  });

  it('sta dietro la stessa decisione di skip di ogni altro step che scrive', () => {
    const step = steps[indexOfName('Report factuality')];
    expect(step.if).toContain("steps.gate.outputs.skipped != 'true'");
  });

  it('ha il token per aprire la issue: senza, fallirebbe in silenzio', () => {
    // `continue-on-error: true` rende un token mancante indistinguibile da un
    // sync pulito — esattamente il modo in cui questo controllo sparirebbe.
    const step = steps[indexOfName('Report factuality')];
    expect(JSON.stringify(step)).toContain('GH_TOKEN');
    expect(doc.permissions.issues).toBe('write');
  });
});
