/**
 * refresh-bfs-stats.yml — il segnale editoriale non parte se l'articolo esiste gia' (#5846).
 *
 * Difetto di rilevamento differito da #5817: lo step «Raise editorial signal for
 * the new quarter» aveva come UNICA condizione `new_quarter != ''` e non
 * verificava mai l'esistenza dell'articolo. Poiche' chiama
 * `github-issue-creator.mjs --reopen-within-hours 720`, un run creato DOPO la
 * chiusura manuale RIAPRE la issue: e' successo il 2026-08-12 alle 20:02:04Z
 * mentre l'articolo del trimestre era live dalle 20:21:13Z. Nessun guard sulla
 * staleness l'avrebbe trattenuto — quel run era legittimamente piu' recente
 * della chiusura. La condizione che mancava riguarda l'ARTICOLO, non il tempo.
 *
 * Il test e' STRUTTURALE su due assi che si sorreggono a vicenda, perche' uno
 * solo non basta:
 *   - il cablaggio (lo step del segnale e' gated sull'output della sonda);
 *   - la direzione del fallimento della sonda (fail OPEN).
 * Una sonda cablata che fallisse chiusa spegnerebbe l'annuncio di un trimestre
 * al primo blip di rete, cioe' esattamente il danno che il segnale esiste per
 * evitare — e lo farebbe in silenzio, con la CI verde.
 *
 * Si legge il workflow con il parser YAML (`parse`) e non con una finestra di
 * byte: gli step vanno cercati per `id`/`name`, cosi' un commento aggiunto o
 * una riga spostata non tingono di rosso una guardia che invece regge.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const WORKFLOW = new URL('../.github/workflows/refresh-bfs-stats.yml', import.meta.url);
const PROBE = new URL('../scripts/ci/bfs-announcement-article-exists.mjs', import.meta.url);

type Step = { name?: string; id?: string; if?: string; env?: Record<string, string>; run?: string };

let steps: Step[];
let probeStep: Step;
let signalStep: Step;
let probeSource: string;

beforeAll(() => {
  steps = parse(readFileSync(WORKFLOW, 'utf8')).jobs.refresh.steps as Step[];
  probeStep = steps.find((s) => s.id === 'article_probe')!;
  signalStep = steps.find((s) => s.name?.startsWith('Raise editorial signal for the new quarter'))!;
  probeSource = readFileSync(PROBE, 'utf8');
});

describe('la sonda di esistenza dell articolo e cablata', () => {
  it('esiste uno step `article_probe` che esegue lo script della sonda', () => {
    expect(probeStep).toBeDefined();
    expect(probeStep.run).toContain('scripts/ci/bfs-announcement-article-exists.mjs');
  });

  it('la sonda riceve il trimestre da `steps.refresh`, non da una costante', () => {
    expect(probeStep.env?.NEW_QUARTER).toContain('steps.refresh.outputs.new_quarter');
  });

  it('lo step del segnale editoriale esiste ed e condizionato sull esito della sonda', () => {
    expect(signalStep).toBeDefined();
    // Le due meta' della condizione, entrambe necessarie: senza la prima il
    // segnale partirebbe a ogni run (2/giorno), senza la seconda tornerebbe il
    // difetto #5846 tale e quale.
    expect(signalStep.if).toContain("steps.refresh.outputs.new_quarter != ''");
    expect(signalStep.if).toContain("steps.article_probe.outputs.exists != 'true'");
  });

  it('la sonda gira PRIMA dello step che condiziona', () => {
    // Un `if` che legge l'output di uno step successivo e' sempre falso in
    // silenzio: la guardia sembrerebbe cablata e non guarderebbe niente.
    const probeIdx = steps.findIndex((s) => s.id === 'article_probe');
    const signalIdx = steps.findIndex((s) => s === signalStep);
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(probeIdx).toBeLessThan(signalIdx);
  });

  it('la soppressione e visibile nel job summary, mai silenziosa', () => {
    const note = steps.find((s) => s.if?.includes("steps.article_probe.outputs.exists == 'true'"));
    expect(note).toBeDefined();
    expect(note!.run).toContain('GITHUB_STEP_SUMMARY');
  });
});

describe('la sonda fallisce APERTA, mai chiusa', () => {
  it('ogni percorso di errore porta a `exists=false`', () => {
    // `setOutput(true, …)` deve comparire una volta sola, sul ramo che ha
    // davvero trovato l'articolo nel ledger. Qualunque altra occorrenza
    // significherebbe un percorso che sopprime il segnale senza la prova.
    const trueCalls = probeSource.match(/setOutput\(\s*true\b/g) || [];
    expect(trueCalls.length).toBe(1);
    // Il catch esiste e riporta false.
    expect(probeSource).toMatch(/catch\s*\([\s\S]{0,400}?setOutput\(false\)/);
  });

  it('legge il ledger del CORPUS, non la copia di questo repo', () => {
    expect(probeSource).toContain('nanakokyobashi-rgb/frontaliere-articles');
    expect(probeSource).toContain('data/article-source-urls.json');
  });

  it('chiede il media type raw alla contents API', () => {
    // Senza `Accept: application/vnd.github.raw` la contents API restituisce
    // `encoding: none` con corpo VUOTO sopra 1 MB. Un corpo vuoto si leggerebbe
    // come «chiave assente», cioe' un falso negativo nella direzione che
    // sopprime il segnale — il fallimento silenzioso peggiore di tutti.
    expect(probeSource).toContain('application/vnd.github.raw');
  });

  it('la chiave cercata e la stessa che il dispatch manda, normalizzata', () => {
    // `recordSourceUrl` (scripts/create-article.mjs) salva la source URL passata
    // da `normalizeNewsUrl`, che minuscola: il ledger del corpus contiene
    // `stats-bfs://2026-q2`, non `stats-bfs://2026-Q2`. Cercare la forma non
    // normalizzata non troverebbe MAI nulla e la guardia sarebbe morta.
    const dispatchStep = steps.find((s) => s.id === 'dispatch')!;
    expect(dispatchStep.run).toContain('stats-bfs://${NEW_QUARTER}');
    expect(probeSource).toContain('`stats-bfs://${q}`.toLowerCase()');
  });
});
