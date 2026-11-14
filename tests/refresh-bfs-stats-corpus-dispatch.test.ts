/**
 * refresh-bfs-stats.yml — il dispatch dell'articolo di annuncio va al CORPUS (#5341),
 * e solo sulla transizione di trimestre.
 *
 * Due incidenti distinti convergono su questo file, e i test servono a tenerli
 * separati per sempre:
 *
 * 1. #5289 — il dispatch LOCALE. Fino al 2026-08-06 questo workflow faceva
 *    `gh workflow run generate-article.yml` su QUESTO repo. Il cutover del
 *    2026-08-02 aveva spostato la generazione su nanako e commentato lo
 *    `schedule:` del produttore locale, ma nessuno aveva aggiornato il dispatch:
 *    il rollover 2026-Q1 → 2026-Q2 ha riacceso il produttore ritirato e, poiché
 *    il suo ultimo step ri-dispaccia se stesso, una spinta trimestrale è diventata
 *    ~22h di scritture non presidiate sul corpus.
 * 2. #5341 — la diagnosi sbagliata. Il fixer autonomo ha concluso «bloccato dai
 *    secret» perché ha cercato `GITHUB_PAT_NANAKO` fra gli Actions secrets. Quel
 *    PAT vive in Firebase Remote Config e viene caricato dallo step
 *    `Load secrets from Remote Config`, che scrive in $GITHUB_ENV.
 *
 * Il fix corretto è quindi un dispatch CROSS-REPO: riaccendere quello locale
 * ripeterebbe #5289, e non dispacciare affatto lascia il trimestre senza articolo.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  GENERATION_WORKFLOW_CONTRACT_MARKER,
  inspectGenerationWorkflowContract,
  generationWorkflowSupportsOrigin,
} from '../functions/src/generationWorkflowContract.js';

const WORKFLOW = new URL('../.github/workflows/refresh-bfs-stats.yml', import.meta.url);
const ASTRA_WORKFLOW = new URL('../.github/workflows/refresh-astra-vehicle-stats.yml', import.meta.url);
const ORIGIN_CONTRACT_HELPER = new URL('../functions/src/generationWorkflowContract.js', import.meta.url);
const CORPUS = 'nanakokyobashi-rgb/frontaliere-articles';
const GENERATION_WORKFLOW = `name: Generate Blog Article
run-name: \${{ github.event_name == 'workflow_dispatch' && inputs.loop_clock != '' && format('Generate Blog Article [loop-clock {0}] [generation-slot {1}]', inputs.loop_clock, inputs.recovery_slot) || 'Generate Blog Article' }}
# generation-cloud-clock-contract: v1
on:
  workflow_dispatch:
    inputs:
      section:
        required: false
        type: string
      url:
        required: false
        type: string
      dry_run:
        required: false
        type: boolean
      dispatch_origin:
        required: true
        type: choice
        options:
          - manual
          - cloud_scheduler
          - chain
          - editorial_signal
      loop_clock:
        required: false
        type: string
      recovery_slot:
        required: false
        type: string
      recovery_claim:
        required: false
        type: string
permissions:
  contents: read
`;

type Step = { name?: string; id?: string; if?: string; env?: Record<string, string>; run?: string };
let raw: string;
let steps: Step[];
let dispatch: Step;
let fallback: Step;

beforeAll(() => {
  raw = readFileSync(WORKFLOW, 'utf8');
  steps = parse(raw).jobs.refresh.steps as Step[];
  dispatch = steps.find((s) => s.id === 'dispatch')!;
  fallback = steps.find((s) => s.name === 'Report a failed corpus dispatch (never silent)')!;
});

describe('il dispatch punta al corpus, non a questo repo (#5289 non si ripete)', () => {
  it('esiste uno step che dispaccia generate-article.yml sul repo del corpus', () => {
    expect(dispatch).toBeDefined();
    expect(dispatch.run).toContain('dispatch_workflow_once generate-article.yml');
    expect(dispatch.run).toContain('source scripts/lib/github-workflow-dispatch-with-retry.sh');
  });

  it('il helper comune riceve sempre il repo del corpus', () => {
    expect(dispatch.run).toContain('dispatch_workflow_once generate-article.yml');
    expect(dispatch.run).toContain(CORPUS);
    expect(dispatch.run).not.toContain('GH_TOKEN="$GITHUB_PAT_NANAKO" gh workflow run');
  });

  it('il workflow non richiede `actions: write` locale: il dispatch è cross-repo e PAT-autenticato', () => {
    const perms = parse(raw).permissions as Record<string, string>;
    expect(perms.actions).toBeUndefined();
  });
});

describe('il dispatch scatta SOLO sulla transizione di trimestre', () => {
  it('è gated su new_quarter non vuoto', () => {
    // Senza questo gate genererebbe un articolo a ogni run (2/giorno).
    expect(dispatch.if).toBe(
      "steps.refresh.outputs.new_quarter != '' && steps.article_probe.outputs.exists != 'true'",
    );
  });

  it('passa il trimestre nella forma attesa dal ricevente (`url=stats-bfs://<quarter>`)', () => {
    expect(dispatch.run).toContain('-f url="stats-bfs://${NEW_QUARTER}"');
    expect(dispatch.env?.NEW_QUARTER).toContain('steps.refresh.outputs.new_quarter');
  });

  it('rileva il contratto sul branch main e non invia input sconosciuti', () => {
    expect(dispatch.run).toContain('gh workflow view generate-article.yml');
    expect(dispatch.run).toContain('node functions/src/generationWorkflowContract.js');
    expect(dispatch.run).toContain("grep -Eq '^      source_key:'");
    expect(dispatch.run).toContain('workflow_dispatch_source_key');
    expect(dispatch.run).toContain('-f "source_key=$source_key"');
    expect(dispatch.run).toContain('dispatch_corpus_article() {');
    expect(dispatch.run).toContain('-f dispatch_origin=editorial_signal "$@"');
    expect(dispatch.run).toContain('dispatch_corpus_article -f url=');
    expect(dispatch.run).toContain('if ! dispatch_corpus_article -f url=');
    expect(dispatch.run).toContain('Dispatch corpus fallito');
    expect(dispatch.run).not.toContain('origin_args[@]');
    expect(dispatch.run.indexOf('gh workflow view')).toBeLessThan(dispatch.run.indexOf('dispatch_workflow_once'));
  });
});

describe('gli altri segnali editoriali dichiarano la propria origine', () => {
  it('i tre dispatch Astra rilevano il contratto prima di passare l’origine', () => {
    const astra = readFileSync(ASTRA_WORKFLOW, 'utf8');
    const dispatches = astra.match(/dispatch_workflow_once generate-article\.yml/g) || [];
    const origins = astra.match(/-f dispatch_origin=editorial_signal "\$@"/g) || [];
    const dispatchFunctions = astra.match(/dispatch_article\(\) \{/g) || [];
    const calls = astra.match(/if dispatch_article -f url=/g) || [];
    expect(dispatches).toHaveLength(6);
    expect(origins).toHaveLength(3);
    expect(dispatchFunctions).toHaveLength(3);
    expect(calls).toHaveLength(3);
    expect(dispatches).toHaveLength(dispatchFunctions.length * 2);
    expect(astra).not.toContain('origin_args[@]');
    expect(astra).toContain('node functions/src/generationWorkflowContract.js');
    expect(astra).toContain("grep -Eq '^      source_key:'");
    expect(astra).toContain('workflow_dispatch_source_key');
  });
});

describe('contratto di origine sender/receiver', () => {
  it('supporta il receiver aggiornato e distingue il receiver legacy', () => {
    const legacy = GENERATION_WORKFLOW.replace(/      dispatch_origin:\n[\s\S]*?(?=      loop_clock:)/u, '');
    const incomplete = GENERATION_WORKFLOW.replace(`${GENERATION_WORKFLOW_CONTRACT_MARKER}\n`, '');
    expect(generationWorkflowSupportsOrigin(legacy)).toBe(false);
    expect(generationWorkflowSupportsOrigin(GENERATION_WORKFLOW, 'editorial_signal')).toBe(true);
    expect(generationWorkflowSupportsOrigin(GENERATION_WORKFLOW, 'cloud_scheduler')).toBe(true);
    expect(generationWorkflowSupportsOrigin(incomplete)).toBe(true);
  });

  it('non prende gli input di workflow_call per completare il payload workflow_dispatch', () => {
    const withoutRecoveryInputs = GENERATION_WORKFLOW.replace(
      /      recovery_slot:\n        required: false\n        type: string\n      recovery_claim:\n        required: false\n        type: string\n/u,
      '',
    );
    const source = withoutRecoveryInputs.replace(
      '\npermissions:',
      '\n  workflow_call:\n    inputs:\n      recovery_slot:\n        required: false\n        type: string\n      recovery_claim:\n        required: false\n        type: string\npermissions:',
    );

    expect(inspectGenerationWorkflowContract(source)).toMatchObject({
      ready: false,
      reason: 'recovery_inputs_missing',
      missingInputs: ['recovery_slot', 'recovery_claim'],
    });
    expect(generationWorkflowSupportsOrigin(source)).toBe(false);

    const result = spawnSync(process.execPath, [fileURLToPath(ORIGIN_CONTRACT_HELPER)], {
      input: source,
      encoding: 'utf8',
    });
    expect(result.stdout.trim()).not.toBe('supported');
  });

  it('rende visibile un YAML non valido invece di permettere un dispatch o un ack', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(ORIGIN_CONTRACT_HELPER)], {
      input: 'on: [\n',
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('generation_workflow_yaml_read_or_parse_failed');
  });

  it('non classifica un workflow vuoto o senza input di base come receiver legacy', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(ORIGIN_CONTRACT_HELPER)], {
      input: 'name: incomplete\n',
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('generation_workflow_dispatch_inputs_invalid');
  });

  it('distingue il receiver legacy dal receiver che accetta l’origine ma ha ancora un contratto slot incompleto', () => {
    const incomplete = GENERATION_WORKFLOW.replace(`${GENERATION_WORKFLOW_CONTRACT_MARKER}\n`, '');
    const incompleteResult = spawnSync(process.execPath, [fileURLToPath(ORIGIN_CONTRACT_HELPER)], {
      input: incomplete,
      encoding: 'utf8',
    });
    expect(incompleteResult.status).toBe(0);
    expect(incompleteResult.stdout.trim()).toBe('supported');

    const legacy = GENERATION_WORKFLOW.replace(/      dispatch_origin:\n[\s\S]*?(?=      loop_clock:)/u, '');
    const legacyResult = spawnSync(process.execPath, [fileURLToPath(ORIGIN_CONTRACT_HELPER)], {
      input: legacy,
      encoding: 'utf8',
    });
    expect(legacyResult.status).toBe(0);
    expect(legacyResult.stdout.trim()).toBe('legacy');
  });

  it('fallisce se il receiver dichiara dispatch_origin ma non accetta l’origine editoriale', () => {
    const workflow = GENERATION_WORKFLOW.replace('          - editorial_signal', '          - unsupported_origin');
    const result = spawnSync(process.execPath, [fileURLToPath(ORIGIN_CONTRACT_HELPER)], {
      input: workflow,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('generation_workflow_dispatch_origin_invalid');
  });
});

describe('il PAT viene da Remote Config e non finisce nei log', () => {
  it('lo step `Load secrets from Remote Config` gira prima del dispatch', () => {
    const names = steps.map((s) => s.name);
    const loadIdx = names.indexOf('Load secrets from Remote Config');
    const dispatchIdx = names.indexOf(dispatch.name!);
    expect(loadIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(loadIdx);
  });

  it('GITHUB_PAT_NANAKO è referenziata per NOME, mai interpolata da Actions', () => {
    // `${{ env.GITHUB_PAT_NANAKO }}` metterebbe il segreto nella command line espansa.
    expect(dispatch.run).toContain('source scripts/lib/github-workflow-dispatch-with-retry.sh');
    expect(dispatch.run).toContain('${GITHUB_PAT_NANAKO:-}');
    expect(raw).not.toContain('${{ env.GITHUB_PAT_NANAKO }}');
    expect(raw).not.toContain('secrets.GITHUB_PAT_NANAKO');
  });

  it('un PAT assente fallisce esplicitamente invece di dispacciare a vuoto', () => {
    // Il loader RC esce 0 anche quando non carica niente: questo è l'unico punto
    // in cui la sua assenza diventa visibile.
    expect(dispatch.run).toContain('if [ -z "${GITHUB_PAT_NANAKO:-}" ]');
    expect(dispatch.run).toContain('exit 1');
  });
});

describe('un dispatch fallito non è mai silenzioso (PAT che ruota)', () => {
  it('il dispatch non fa fallire il run, ma il fallimento apre una issue', () => {
    expect(dispatch['continue-on-error' as keyof Step]).toBe(true);
    expect(fallback).toBeDefined();
    expect(fallback.if).toContain("steps.dispatch.outcome == 'failure'");
    expect(fallback.run).toContain('github-issue-creator.mjs');
  });

  it("la issue di fallback nasce solo su nuovo trimestre (niente rumore fuori dalla transizione)", () => {
    expect(fallback.if).toContain("steps.refresh.outputs.new_quarter != ''");
  });

  it('il titolo della fallback è statico e senza trimestre (#5121, dedup a 60 char)', () => {
    // Un titolo che si muove coi dati non ritrova mai la sua issue canonica: ogni
    // run ne conia una nuova e il fixer serializzato brucia un turno su ciascuna.
    const title = fallback.run!.match(/--title "([^"]+)"/)![1];
    expect(title).not.toMatch(/\$\{|\$\(/);
    expect(title).toBe('Dispatch articolo BFS al corpus fallito');
  });
});

describe("il commento d'intestazione non dichiara più un blocco inesistente", () => {
  it('non afferma che il dispatch cross-repo sia da fare / bloccato', () => {
    // La frase rimossa («It is not done here on purpose: it needs
    // GITHUB_PAT_NANAKO and a receiving trigger on that side») ha già depistato
    // due run del fixer autonomo.
    expect(raw).not.toContain('It is not done');
    expect(raw).not.toContain('which is a change in a repo this workflow cannot test against');
  });

  it('documenta dove vive davvero il PAT, che è la diagnosi che è mancata', () => {
    expect(raw).toContain('Firebase Remote Config');
    expect(raw).toContain('NOT from Actions secrets');
  });
});
