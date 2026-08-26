/**
 * Schema statico degli step `background:` / `wait-all:`.
 *
 * PERCHE' ESISTE, e perche' non bastava actionlint. Questa coppia di chiavi e'
 * il solo meccanismo di parallelismo INTRA-job che il runner offre, ed e' usata
 * 1.223 volte in 245 workflow di questo repo (misurato 2026-08-26). Non fa
 * parte dello schema pubblico documentato da GitHub, e cio' ha una conseguenza
 * che si paga cara: chi valida i workflow in locale — `actionlint`, un
 * `YAML.parse`, un editor con lo schema JSON di Actions — NON conosce ne'
 * `background:` ne' `wait-all:`, quindi non ha alcuna opinione su quali ALTRE
 * chiavi possano stargli accanto. Tutte e tre tacciono su un file che GitHub
 * rifiutera'.
 *
 * E il rifiuto non si presenta come un errore di sintassi. Si presenta come una
 * run in stato `failure` con ZERO job: nessun annotation, nessun log, nessun
 * check-run. Su `tests.yml` — che PRODUCE il check-run `vitest (unit +
 * integration)`, l'unico su cui `auto-merge-eval.mjs` fa `select` — quella
 * forma vuol dire che il gate di merge semplicemente non esiste per quel
 * commit.
 *
 * Le due regole qui sotto sono entrambe state imparate da un incidente reale,
 * non dedotte:
 *
 *  1. Uno step `wait-all` accetta SOLO `name:` e `wait-all:`. Il tentativo di
 *     dargli anche un `if:` — per rijoinare solo cio' che si era davvero
 *     forkato, dato che nel job fuso di `tests.yml` il join gira anche su
 *     `push` mentre gli step in background sono `pull_request`-only — ha fatto
 *     rifiutare l'INTERO file: run 32936857718, `failure`, zero job. Il join a
 *     vuoto e' comunque innocuo (senza background outstanding non c'e' niente
 *     da attendere), quindi la condizione non serviva nemmeno.
 *
 *  2. `background:` vale solo su uno step `run:`. Su uno step `uses:` rompe il
 *     file allo stesso modo (incidente PR #4777, e le testate di
 *     `.github/actions/setup-headroom/{action.yml,install.sh}` lo ripetono a
 *     chi fosse tentato di spostare l'install dentro la composite). E' la
 *     ragione per cui in `tests.yml` l'assemble DEVE restare un `run:` e non
 *     puo' diventare una action condivisa.
 *
 * Il test e' zero-Claude, deterministico, e gira su TUTTI i workflow: le due
 * regole non sono una peculiarita' di `tests.yml`, e i crawler-group (dove
 * stanno ~1.200 dei background) sono generati da script — una regressione li'
 * arriverebbe in blocco su decine di file insieme.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = resolve(ROOT, '.github/workflows');

type Step = Record<string, unknown>;
interface Located {
  file: string;
  job: string;
  index: number;
  name: string;
  keys: string[];
  step: Step;
}

/**
 * Anti-vacuita': se un giorno la glob, il parser o la forma dei workflow
 * cambiano e lo scan torna vuoto, il test passerebbe senza aver guardato
 * niente. Questi minimi sono ben SOTTO le cifre misurate (245 file, 51
 * wait-all, 1.223 background) — non sono un ratchet da aggiornare a ogni
 * aggiunta, sono una soglia di plausibilita' che solo un guasto dello scan
 * puo' violare.
 */
const MIN_FILES = 100;
const MIN_WAIT_STEPS = 20;
const MIN_BACKGROUND_STEPS = 200;

const parseErrors: string[] = [];
const waitSteps: Located[] = [];
const backgroundSteps: Located[] = [];
let scannedFiles = 0;

for (const file of readdirSync(WORKFLOW_DIR).sort()) {
  if (!/\.ya?ml$/.test(file)) continue;
  scannedFiles += 1;
  let doc: unknown;
  try {
    doc = YAML.parse(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
  } catch (e) {
    parseErrors.push(`${file}: ${(e as Error).message}`);
    continue;
  }
  const jobs = (doc as { jobs?: Record<string, { steps?: unknown[] }> })?.jobs ?? {};
  for (const [job, body] of Object.entries(jobs)) {
    const steps = Array.isArray(body?.steps) ? body.steps : [];
    steps.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const step = raw as Step;
      const keys = Object.keys(step);
      const located: Located = {
        file,
        job,
        index,
        name: typeof step.name === 'string' ? step.name : `<step #${index}>`,
        keys,
        step,
      };
      if (keys.includes('wait-all')) waitSteps.push(located);
      if (keys.includes('background')) backgroundSteps.push(located);
    });
  }
}

const where = (s: Located) => `${s.file} → job \`${s.job}\` → "${s.name}"`;

describe('background:/wait-all: step schema (invisibile ad actionlint)', () => {
  it('ogni workflow si parsa: uno scan cieco non e\' uno scan verde', () => {
    expect(parseErrors, `workflow non parsabili:\n${parseErrors.join('\n')}`).toEqual([]);
    expect(scannedFiles).toBeGreaterThanOrEqual(MIN_FILES);
  });

  it('lo scan trova davvero gli step che deve giudicare', () => {
    // Senza questo, cancellare la ricerca renderebbe verdi le due regole sotto.
    expect(waitSteps.length).toBeGreaterThanOrEqual(MIN_WAIT_STEPS);
    expect(backgroundSteps.length).toBeGreaterThanOrEqual(MIN_BACKGROUND_STEPS);
  });

  it('uno step `wait-all` non porta NESSUNA altra chiave oltre `name` (run 32936857718)', () => {
    const offenders = waitSteps
      .filter((s) => s.keys.some((k) => k !== 'name' && k !== 'wait-all'))
      .map((s) => `${where(s)} — chiavi extra: ${s.keys.filter((k) => k !== 'name' && k !== 'wait-all').join(', ')}`);
    expect(
      offenders,
      'GitHub RIFIUTA l\'intero file workflow se uno step `wait-all` porta altre chiavi ' +
        '(un `if:` e\' bastato: run 32936857718 → `failure` con ZERO job, nessuna annotation). ' +
        'Un join a vuoto e\' innocuo: togli la chiave, non condizionare il join.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('`wait-all` e\' il booleano letterale `true`, non un\'espressione', () => {
    // `${{ }}` qui non viene valutato: finirebbe come stringa e ricadrebbe nel
    // caso "chiave che il runner non sa interpretare".
    const offenders = waitSteps
      .filter((s) => s.step['wait-all'] !== true)
      .map((s) => `${where(s)} — \`wait-all: ${JSON.stringify(s.step['wait-all'])}\``);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('`background:` sta solo su uno step `run:`, mai su `uses:` (PR #4777)', () => {
    const offenders = backgroundSteps
      .filter((s) => s.keys.includes('uses') || !s.keys.includes('run'))
      .map((s) => `${where(s)} — \`uses: ${String(s.step.uses ?? '<nessun run:>')}\``);
    expect(
      offenders,
      '`background:` su uno step `uses:` non e\' supportato e rompe il file workflow ' +
        '(PR #4777). Se il lavoro deve stare in una composite action, la composite va ' +
        'INVOCATA da uno step `run:` (modello `.github/actions/setup-headroom/install.sh`).\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('`background:` e\' il booleano letterale `true`, non un\'espressione', () => {
    const offenders = backgroundSteps
      .filter((s) => s.step.background !== true)
      .map((s) => `${where(s)} — \`background: ${JSON.stringify(s.step.background)}\``);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('ogni step in background e\' rijoinato da un `wait-all` piu\' in basso nello stesso job', () => {
    // Un background senza join non e' un errore di schema — e' un errore di
    // SEMANTICA: il job puo' finire mentre il processo lavora ancora, e in
    // `tests.yml` significherebbe un gate bloccante il cui esito non viene mai
    // letto (un rosso che non arrossa niente).
    const byJob = new Map<string, { bg: Located[]; wait: number[] }>();
    for (const s of backgroundSteps) {
      const key = `${s.file}::${s.job}`;
      if (!byJob.has(key)) byJob.set(key, { bg: [], wait: [] });
      byJob.get(key)!.bg.push(s);
    }
    for (const s of waitSteps) {
      const key = `${s.file}::${s.job}`;
      if (!byJob.has(key)) byJob.set(key, { bg: [], wait: [] });
      byJob.get(key)!.wait.push(s.index);
    }
    const offenders: string[] = [];
    for (const [, { bg, wait }] of byJob) {
      for (const s of bg) {
        if (!wait.some((w) => w > s.index)) offenders.push(`${where(s)} — nessun \`wait-all\` dopo di lui`);
      }
    }
    expect(
      offenders,
      'step lanciati in background e mai rijoinati: il job puo\' concludersi mentre ' +
        'ancora lavorano, quindi il loro esito non entra nel verdetto.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
