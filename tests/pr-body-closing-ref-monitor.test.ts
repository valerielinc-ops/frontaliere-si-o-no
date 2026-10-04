/**
 * pr-body-closing-ref-monitor — il fixer non chiude al merge una issue che un
 * monitor chiude da sé sulla misura.
 *
 * Una issue `[crawler-health] <slug>: crawler unhealthy` la apre e la risolve
 * `crawler-health-monitor.yml`: lo step che seleziona le aperte con quel
 * prefisso e chiama `github-issue-creator.mjs --resolve` quando il crawler
 * torna `healthy`. Se il body della PR del fix dice `Closes #N`, GitHub la
 * chiude al MERGE, prima che un crawl abbia eseguito il codice nuovo; la misura
 * successiva la trova ancora rotta, la riapre, e il fixer riparte
 * (2026-10-02/03: #10945, #10947, #10948, #11089). `closingRefFor` emette quindi
 * `Addresses #N` per quel prefisso.
 *
 * `Addresses` è sicuro SOLO finché il closer del monitor esiste e seleziona lo
 * stesso prefisso: senza, la issue resterebbe aperta per sempre. Il secondo
 * blocco lega la regex del generatore al filtro di quello step, letto dal YAML.
 *
 * Se questo test diventa rosso: «Closes su issue [crawler-health]: il closer
 * del monitor o il prefisso del titolo non coincidono più».
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  MONITOR_OWNED_CLOSE_TITLE_RE,
  closingRefFor,
} from '../scripts/lib/pr-body-generator-contract.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONITOR_WORKFLOW = '.github/workflows/crawler-health-monitor.yml';

type Step = { name?: string; run?: string };
type Workflow = { on?: Record<string, unknown>; jobs?: Record<string, { steps?: Step[] }> };

async function monitorWorkflow(): Promise<Workflow> {
  const raw = await fs.readFile(path.join(REPO, MONITOR_WORKFLOW), 'utf-8');
  return YAML.parse(raw) as Workflow;
}

async function monitorSteps(): Promise<Step[]> {
  const wf = await monitorWorkflow();
  return Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

/** Lo step che RISOLVE le issue: chiama il creator con `--resolve`. */
function findCloser(steps: Step[]): Step | undefined {
  return steps.find((s) => /github-issue-creator\.mjs\s+--resolve/.test(s.run ?? ''));
}

/**
 * Estrae la regex del filtro jq `select(.title | test("…"))` e la decodifica
 * come stringa jq (stesso escaping di JSON), cioè la regex che jq esegue.
 */
function closerTitleRegexSource(run: string): string | null {
  const m = run.match(/select\(\s*\.title\s*\|\s*test\(\s*("(?:[^"\\]|\\.)*")\s*\)\s*\)/);
  if (!m) return null;
  return JSON.parse(m[1]) as string;
}

describe('closingRefFor sulle issue di un monitor', () => {
  const crawlerHealth = [{ name: 'crawler-health' }];

  it('emette Addresses per una issue [crawler-health]', async () => {
    const res = closingRefFor({
      number: 10945,
      title: '[crawler-health] coop-ticino: crawler unhealthy',
      body: '',
      labels: crawlerHealth,
    })!;
    expect(res.keyword).toBe('Addresses');
    expect(res.line).toBe('Addresses #10945');
    expect(res.aggregate).toBe(false);
    expect(res.reason).toMatch(/monitor/);
  });

  it('lascia Closes alla stessa issue con un titolo ordinario', async () => {
    const res = closingRefFor({ number: 10945, title: 'Fix crawler Coop', body: '', labels: crawlerHealth })!;
    expect(res.keyword).toBe('Closes');
    expect(res.line).toBe('Closes #10945');
  });

  it('il prefisso conta solo in testa al titolo', async () => {
    const res = closingRefFor({
      number: 12,
      title: 'Rivedere le issue [crawler-health] aperte',
      body: '',
      labels: [],
    })!;
    expect(res.keyword).toBe('Closes');
  });

  it('un riferimento a una PR resta Closes anche con il prefisso', async () => {
    const res = closingRefFor({
      number: 10995,
      title: '[crawler-health] coop-ticino: crawler unhealthy',
      body: '',
      labels: crawlerHealth,
      pull_request: { url: 'https://example.invalid/pulls/10995' },
    })!;
    expect(res.keyword).toBe('Closes');
    expect(res.reason).toBe('pull-request-ref');
  });

  it('una follow-up aggregata resta Addresses come prima', async () => {
    const res = closingRefFor({
      number: 5834,
      title: 'follow-up(#1): 3 items deferred — x',
      body: '',
      labels: [{ name: 'follow-up' }],
    })!;
    expect(res.keyword).toBe('Addresses');
    expect(res.aggregate).toBe(true);
  });
});

describe('accoppiamento con il closer di crawler-health-monitor.yml', () => {
  it('lo step che risolve le issue esiste, gira a cron e filtra con lo stesso prefisso', async () => {
    const steps = await monitorSteps();
    const closer = findCloser(steps);
    expect(
      closer,
      `${MONITOR_WORKFLOW} non ha più uno step che chiama github-issue-creator.mjs --resolve: `
        + 'con Addresses le issue [crawler-health] resterebbero aperte per sempre. '
        + 'Ripristina il closer oppure togli il prefisso da MONITOR_OWNED_CLOSE_TITLE_RE.',
    ).toBeTruthy();

    const source = closerTitleRegexSource(closer!.run!);
    expect(
      source,
      `lo step «${closer!.name}» non seleziona più le issue con select(.title | test("…")): `
        + 'il test non può provare che chiuda le stesse issue a cui il generatore scrive Addresses.',
    ).not.toBeNull();
    expect(
      source,
      `Closes su issue [crawler-health]: il closer del monitor («${closer!.name}») `
        + 'e MONITOR_OWNED_CLOSE_TITLE_RE non selezionano più lo stesso prefisso.',
    ).toBe(MONITOR_OWNED_CLOSE_TITLE_RE.source);

    const wf = await monitorWorkflow();
    expect(
      wf.on?.schedule,
      `${MONITOR_WORKFLOW} non gira più a cron: il closer non passerebbe mai da solo.`,
    ).toBeTruthy();
  });

  it('i titoli che il monitor apre e ricostruisce per --resolve sono quelli del generatore', async () => {
    const steps = await monitorSteps();
    const closer = findCloser(steps)!;
    // Il titolo è letterale nello script: `title="[crawler-health] ${slug}: …"`.
    // Lo si rende con uno slug vero e lo si passa alla regex del generatore.
    const templatesOf = (s: Step) =>
      [...(s.run ?? '').matchAll(/title="([^"]*\$\{slug\}[^"]*)"/g)].map((m) => m[1]);
    const closerTemplates = templatesOf(closer);
    const openerTemplates = steps.filter((s) => s !== closer).flatMap(templatesOf);
    expect(closerTemplates.length, 'il closer non ricostruisce più il titolo da ${slug}').toBeGreaterThan(0);
    expect(openerTemplates.length, 'nessuno step apre più issue con un titolo da ${slug}').toBeGreaterThan(0);
    for (const tpl of [...openerTemplates, ...closerTemplates]) {
      const rendered = tpl.replace('${slug}', 'coop-ticino');
      expect(
        MONITOR_OWNED_CLOSE_TITLE_RE.test(rendered),
        `il monitor apre/risolve «${rendered}», che MONITOR_OWNED_CLOSE_TITLE_RE non riconosce: `
          + 'il fixer tornerebbe a scrivere Closes.',
      ).toBe(true);
      expect(closingRefFor({ number: 1, title: rendered, body: '', labels: [] })!.keyword).toBe('Addresses');
    }
  });
});
