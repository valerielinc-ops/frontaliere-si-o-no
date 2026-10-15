// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  CLOSE_ACTIONS,
  decideFailureIssueClose,
} from '../scripts/ci/close-recovered-failure-issues.mjs';

// Guardiano dell'incidente 9321 (FU-2026-09-20-008, gemello corpus 170): lo
// sweep del backlog chiuse `Workflow Failure: Post-merge follow-up triage` con
// `maybe-resolved` mentre l'ultima run completata era ancora rossa, e il canale
// d'allarme tacque. Invariante: nessuna chiusura di una issue di failure senza
// una run verde successiva all'apertura.
//
// LC-06: l'invariante non vive più in prosa nel prompt. La prosa ricalcolava
// l'oracolo del closer senza scartare le run `skipped` (issue 9285 «D» a ogni
// giro) e ordinava `gh issue close`, che il bridge Codex rifiuta (le C restavano
// aperte in silenzio). Ora il verdetto lo calcola il closer nel job
// `failure_verdicts` e lo sweep lo legge da file; lo sweep non chiude nulla.
//
// Se questa suite diventa rossa il titolo del guasto è:
// «Sweep del backlog: chiusura ordinata dal prompt o oracolo del closer ricalcolato in prosa».
const workflow = readFileSync('.github/workflows/needs-human-sweep.yml', 'utf8');
const doc = YAML.parse(workflow);
const jobs = doc.jobs ?? {};

function sweepPrompt(): string {
  for (const job of Object.values<any>(jobs)) {
    for (const step of job?.steps ?? []) {
      if (step?.id === 'codex_sweep') return String(step.with?.prompt ?? '');
    }
  }
  throw new Error('codex_sweep step not found');
}

const prompt = sweepPrompt();
const verdictsJob = jobs.failure_verdicts;
const sweepJob = jobs.sweep;
const VERDICTS_FILE = '.sweep-input/failure-verdicts.json';

function closerStep(): any {
  return (verdictsJob?.steps ?? []).find((s: any) => String(s?.run ?? '').includes('close-recovered-failure-issues.mjs'));
}

describe('needs-human sweep: lo sweep non ordina chiusure', () => {
  it('il prompt non contiene nessun comando di chiusura', () => {
    expect(prompt).not.toMatch(/gh issue close/);
    expect(prompt).not.toMatch(/\bissue close\b/);
  });

  it('una C non-failure diventa una richiesta all\'orchestratore con il marker, label invariate', () => {
    expect(prompt).toContain('<!-- SWEEP_CLOSE_REQUEST: issue=<N> -->');
    expect(prompt).toMatch(/le label non cambiano/);
    expect(prompt).toMatch(/Se il marker c'è già e nessun commento successivo lo contraddice, la issue non consuma un'azione/);
    expect(prompt).toContain('«C misurate, chiusura all\'orchestratore»');
  });

  it('la guardia sui gate SEO resta: quelle issue le chiude solo il loro gate', () => {
    expect(prompt).toContain('`Validation Failure (dist): <gate>` e `SEO gates regression: <gate> above baseline` NON si chiudono qui');
  });
});

describe('needs-human sweep: le issue di failure leggono il verdetto del closer', () => {
  it('il prompt non ricalcola l\'oracolo in prosa', () => {
    expect(prompt).not.toMatch(/gh run list --repo \$REPO -w/);
    expect(prompt).not.toMatch(/status == completed/);
  });

  it('il prompt nomina il file dei verdetti e senza verdetto la issue non si tocca', () => {
    expect(prompt).toContain(VERDICTS_FILE);
    expect(prompt).toMatch(/`\^\(Workflow\|Crawler\|CI\) Failure: `/);
    expect(prompt).toMatch(/File assente o illeggibile, oppure issue non elencata → la issue NON si tocca in questo giro/);
  });

  it('il prompt sa leggere ogni azione che il closer può scrivere', () => {
    for (const action of CLOSE_ACTIONS) expect(prompt, action).toContain(`\`${action}\``);
    expect(prompt).toMatch(/`close` → nessuna azione: la chiude il closer/);
    expect(prompt).toMatch(/`keep` → classe B o D come le altre issue; mai C/);
  });
});

describe('needs-human sweep: job failure_verdicts', () => {
  it('esiste, gira prima dello sweep, e un suo rosso non ferma lo sweep', () => {
    expect(verdictsJob).toBeTruthy();
    const needs = [sweepJob?.needs].flat();
    expect(needs).toContain('failure_verdicts');
    // `needs` senza funzione di stato = `success()` implicito.
    expect(String(sweepJob?.if ?? '')).toMatch(/!cancelled\(\)/);
    // Stessa finestra dello sweep: il cron del pre-pass non paga il closer.
    expect(String(verdictsJob.if)).toContain("github.event.schedule == '37 5 * * *'");
    expect(String(sweepJob.if)).toContain("github.event.schedule == '37 5 * * *'");
  });

  it('ha l\'ambiente del closer orario: Remote Config, CRAWLER_RUN_REPO, errore senza GITHUB_PAT_NANAKO', () => {
    const steps = verdictsJob.steps ?? [];
    const rcAt = steps.findIndex((s: any) => String(s?.run ?? '').includes('node scripts/load-rc-env.mjs'));
    const closer = closerStep();
    expect(rcAt).toBeGreaterThanOrEqual(0);
    expect(closer).toBeTruthy();
    expect(steps.indexOf(closer)).toBeGreaterThan(rcAt);
    expect(closer.env?.CRAWLER_RUN_REPO).toBe('nanakokyobashi-rgb/frontaliere-articles');
    expect(String(closer.run)).toMatch(/if \[ -z "\$\{GITHUB_PAT_NANAKO:-\}" \]; then[\s\S]*?exit 1/);
    expect(String(closer.run)).toMatch(/close-recovered-failure-issues\.mjs --dry-run --verdicts-out /);
  });

  it('ha permessi di sola lettura e nessun agente', () => {
    const perms = verdictsJob.permissions ?? {};
    expect(Object.keys(perms).length).toBeGreaterThan(0);
    for (const [scope, level] of Object.entries(perms)) expect(level, scope).toBe('read');
    expect(JSON.stringify(verdictsJob)).not.toContain('claude-codex-fallback');
  });

  it('il file scritto dal closer è quello che lo sweep scarica e il prompt legge', () => {
    const closer = closerStep();
    const outPath = /--verdicts-out "([^"]+)"/.exec(String(closer.run))?.[1] ?? '';
    const upload = (verdictsJob.steps ?? []).find((s: any) => String(s?.uses ?? '').startsWith('actions/upload-artifact@'));
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    const uploadPath = String(upload?.with?.path ?? '');
    expect(path.basename(uploadPath)).toBe(path.basename(outPath));

    const download = (sweepJob.steps ?? []).find((s: any) => String(s?.uses ?? '').startsWith('actions/download-artifact@'));
    expect(download?.with?.name).toBe(upload?.with?.name);
    expect(download?.['continue-on-error']).toBe(true);
    expect(path.posix.join(String(download?.with?.path), path.basename(outPath))).toBe(VERDICTS_FILE);
    // Il sandbox Codex legge solo dentro il workspace.
    expect(String(download?.with?.path)).not.toMatch(/runner\.temp|RUNNER_TEMP|^\//);
  });

  it('il token del corpus non entra nel job dell\'agente', () => {
    const sweep = JSON.stringify(sweepJob);
    expect(sweep).not.toContain('GITHUB_PAT_NANAKO');
    expect(sweep).not.toContain('load-rc-env.mjs');
    expect(sweep).not.toContain('FIREBASE_SERVICE_ACCOUNT_JSON');
  });
});

describe('needs-human sweep: l\'invariante dell\'incidente 9321 vive nel closer', () => {
  const NOW = Date.parse('2026-10-03T12:00:00Z');
  const HOUR = 3600 * 1000;
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const issue = { number: 9321, title: 'Workflow Failure: Post-merge follow-up triage', createdAt: at(2 * HOUR), labels: [] };
  const run = (id: number, conclusion: string, msAgo: number) => ({ databaseId: id, status: 'completed', conclusion, createdAt: at(msAgo) });

  it('un verde PRECEDENTE all\'apertura → keep', () => {
    const verdict = decideFailureIssueClose({ issue, history: [run(1, 'success', 3 * HOUR)], comments: null, now: NOW });
    expect(verdict.action).toBe('keep');
    expect(verdict.reason).toBe('green-predates-issue');
  });

  it('ultima run rossa dopo un verde → keep', () => {
    const verdict = decideFailureIssueClose({
      issue,
      history: [run(2, 'failure', HOUR), run(1, 'success', 90 * 60 * 1000)],
      comments: null,
      now: NOW,
    });
    expect(verdict.action).toBe('keep');
  });

  it('le run skipped non decidono: [skipped, success dopo l\'apertura] decide la success (causa della 9285)', () => {
    // Discrimina: senza lo scarto delle skipped decide la run 3 (skipped) e il
    // verdetto è still-red; con lo scarto decide la run 5, verde dopo l'apertura.
    const verdict = decideFailureIssueClose({
      issue,
      history: [run(3, 'skipped', 5 * 60 * 1000), run(5, 'success', HOUR)],
      comments: [],
      now: NOW,
    });
    expect(verdict.runId).toBe(5);
    expect(verdict.reason).not.toBe('still-red');
  });

  it('le run skipped non decidono: [skipped, skipped, failure] resta rossa', () => {
    const verdict = decideFailureIssueClose({
      issue,
      history: [run(3, 'skipped', 5 * 60 * 1000), run(4, 'skipped', 10 * 60 * 1000), run(5, 'failure', HOUR)],
      comments: null,
      now: NOW,
    });
    expect(verdict.action).toBe('keep');
    expect(verdict.reason).toBe('still-red');
  });
});
