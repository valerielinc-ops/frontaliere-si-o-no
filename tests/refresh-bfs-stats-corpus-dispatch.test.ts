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
import { parse } from 'yaml';

const WORKFLOW = new URL('../.github/workflows/refresh-bfs-stats.yml', import.meta.url);
const CORPUS = 'nanakokyobashi-rgb/frontaliere-articles';

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
    expect(dispatch.run).toContain('gh workflow run generate-article.yml');
    expect(dispatch.run).toContain(`--repo ${CORPUS}`);
  });

  it('OGNI `gh workflow run` ESEGUITO dal workflow è indirizzato al corpus', () => {
    // È l'invariante che impedisce il ritorno di #5289: un dispatch senza `--repo`
    // colpisce il repo corrente, cioè il produttore ritirato che si ri-dispaccia.
    // Si guardano gli step ESEGUITI, non il testo grezzo: i commenti e i corpi delle
    // issue citano legittimamente il comando senza eseguirlo.
    const dispatching = steps.filter((s) => s.run?.includes('gh workflow run'));
    expect(dispatching.length).toBeGreaterThan(0);
    for (const step of dispatching) {
      for (const line of step.run!.split('\n').filter((l) => l.includes('gh workflow run'))) {
        // Il comando è multi-riga (continuazioni con `\`), quindi si verifica il blocco.
        expect(line).toContain('generate-article.yml');
      }
      expect(step.run).toContain(`--repo ${CORPUS}`);
    }
  });

  it('il workflow non richiede `actions: write` locale: il dispatch è cross-repo e PAT-autenticato', () => {
    const perms = parse(raw).permissions as Record<string, string>;
    expect(perms.actions).toBeUndefined();
  });
});

describe('il dispatch scatta SOLO sulla transizione di trimestre', () => {
  it('è gated su new_quarter non vuoto', () => {
    // Senza questo gate genererebbe un articolo a ogni run (2/giorno).
    expect(dispatch.if).toBe("steps.refresh.outputs.new_quarter != ''");
  });

  it('passa il trimestre nella forma attesa dal ricevente (`url=stats-bfs://<quarter>`)', () => {
    expect(dispatch.run).toContain('-f url="stats-bfs://${NEW_QUARTER}"');
    expect(dispatch.env?.NEW_QUARTER).toContain('steps.refresh.outputs.new_quarter');
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
    expect(dispatch.run).toContain('GH_TOKEN="$GITHUB_PAT_NANAKO"');
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
    expect(fallback.if).toContain("steps.dispatch.outcome != 'success'");
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
