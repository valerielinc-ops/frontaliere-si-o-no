import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Il wiring del curated article-fabrication-guard dentro
 * `sync-articles-sitemaps.yml` (issue #5671).
 *
 * Sorella di `tests/workflows/sync-articles-factuality-step.test.ts` (#5595),
 * ma per un gate diverso: quello e' `scripts/lib/article-factuality-gates.mjs`
 * (arithmetic, tax plausibility, istituzione-con-acronimo-tra-parentesi);
 * questo e' il denylist curato dietro `tests/article-fabrication-guard.test.ts`
 * (nomi di istituzioni e acronimi osservati come inventati, senza richiedere
 * la forma "(ACRONIMO)"). Nessuno dei due episodi che #5671 nomina —
 * "Ufficio federale del lavoro" (nessun acronimo tra parentesi) e l'acronimo
 * nudo "LTL" — avrebbe fatto scattare il gate di factuality: serviva
 * QUESTO step, e prima di questa PR non esisteva.
 *
 * Stesso motivo d'essere del test gemello: prima del cutover del 2026-08-02
 * questo repo generava e pubblicava i propri articoli, quindi ogni check
 * legato al commit vedeva il contenuto nuovo. Dal cutover il sync commit
 * arriva DIRETTAMENTE su `main`, senza PR — verificato: zero check-run
 * `push` su un commit di sync, solo `schedule`/`workflow_run` — quindi
 * `npm test` (e con esso `tests/article-fabrication-guard.test.ts`) non vede
 * mai il contenuto sul percorso che lo pubblica davvero. Le due proprieta'
 * che contano sono invisibili a una review superficiale del diff: che lo
 * step stia PRIMA del commit, e che di default non possa fermare la
 * pubblicazione.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'sync-articles-sitemaps.yml');
const REPORTER = 'scripts/ci/report-synced-article-fabrication.mjs';

type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean | string;
};

const doc = parseYaml(fs.readFileSync(WORKFLOW, 'utf-8')) as {
  permissions: Record<string, string>;
  jobs: { sync: { steps: Step[] } };
};
const steps = doc.jobs.sync.steps;
const indexOfName = (fragment: string) => steps.findIndex((s) => s.name?.includes(fragment));

describe('sync-articles-sitemaps.yml: il fabrication guard e` collegato al punto giusto', () => {
  it('invoca il reporter', () => {
    const i = indexOfName('article-fabrication-guard findings');
    expect(i, 'lo step manca: il fabrication guard tornerebbe a non girare su nessun articolo pubblicato — issue #5671').toBeGreaterThan(-1);
    expect(steps[i].run).toContain(REPORTER);
  });

  it('gira PRIMA del commit, che e` l`unico momento in cui il diff esiste', () => {
    // Dopo il commit `git diff` e` pulito e `changedArticleIdsWorktree()` non
    // vedrebbe piu` niente: lo step resterebbe verde verificando zero
    // articoli — la stessa forma di gate vacuo che #5595 ha gia` riparato una
    // volta, per il gate gemello.
    const step = indexOfName('article-fabrication-guard findings');
    const commit = indexOfName('Commit if changed');
    expect(commit).toBeGreaterThan(-1);
    expect(step).toBeLessThan(commit);
  });

  it('gira DOPO il pull del corpus, altrimenti giudicherebbe l`albero vecchio', () => {
    expect(indexOfName('article-fabrication-guard findings'))
      .toBeGreaterThan(indexOfName('Pull the article corpus'));
  });

  it('di default NON puo` fermare la pubblicazione', () => {
    // Il passaggio a bloccante e` una decisione del proprietario
    // (#5630/#5595/#5696, ancora aperta), non un effetto collaterale di un
    // refactor del workflow. Di default (repository variable assente) la
    // condizione e` vera → continue-on-error resta true.
    const step = steps[indexOfName('article-fabrication-guard findings')];
    expect(step['continue-on-error']).toBe("${{ vars.ARTICLE_FABRICATION_GUARD_BLOCKING != 'true' }}");
  });

  it('il flag per passare a bloccante esiste ed e` cablato allo step', () => {
    const step = steps[indexOfName('article-fabrication-guard findings')];
    expect(step.env?.ARTICLE_FABRICATION_GUARD_BLOCKING).toBe('${{ vars.ARTICLE_FABRICATION_GUARD_BLOCKING }}');
  });

  it('sta dietro la stessa decisione di skip di ogni altro step che scrive', () => {
    const step = steps[indexOfName('article-fabrication-guard findings')];
    expect(step.if).toContain("steps.gate.outputs.skipped != 'true'");
  });

  it('ha il token per aprire/chiudere la issue: senza, fallirebbe in silenzio', () => {
    // `continue-on-error` (di default) rende un token mancante indistinguibile
    // da un sync pulito — esattamente il modo in cui questo controllo
    // sparirebbe senza che nessuno se ne accorga.
    const step = steps[indexOfName('article-fabrication-guard findings')];
    expect(JSON.stringify(step)).toContain('GH_TOKEN');
    expect(doc.permissions.issues).toBe('write');
  });
});
