/**
 * close-recovered-recurrence.test.mjs — un fallimento che RICORRE non è un
 * fallimento risolto.
 *
 * Il reconciler chiudeva sulla sola domanda «l'ultima run è verde?», e su un
 * guasto intermittente quella domanda ha sempre risposta sì. Misurato su questo
 * repo il 2026-08-18: la issue #249 `Workflow Failure: Generate Blog Article`
 * (il wedge di `generate-article.yml`, 42 run su 69 fallimenti dal 13-08, 26,6
 * ore di runner in 5 giorni) è stata auto-chiusa 37 volte in 7 giorni, con 45
 * commenti `🔁` di ricorrenza. Viveva fra i 5 e i 40 minuti per volta e non è
 * mai entrata né nella coda del fixer né in un triage umano.
 *
 * I numeri delle fixture qui sotto sono quelli misurati sulle run vere
 * (`gh run list -w 'Generate Blog Article' -b main -L 900`), non inventati.
 */
import { test, expect } from 'vitest';
// Gemella di `generator/tests/close-recovered-recurrence.test.mjs` sul corpus
// (`nanakokyobashi-rgb/frontaliere-articles`), che gira su `node --test`. Lo script
// sotto test è `mode: identical` nel loop-sync-manifest, quindi le due suite devono
// restare equivalenti: questi quattro shim tengono il corpo dei test identico a quello
// del gemello, così un diff fra i due file mostra solo le differenze VERE (qui non c'è
// `scripts/ci/scan-failed-runs.mjs`, che è corpus-only).
const eq = <T,>(actual: T, expected: T, msg?: string) => expect(actual, msg).toStrictEqual(expected);
const deepEq = <T,>(actual: T, expected: T, msg?: string) => expect(actual, msg).toStrictEqual(expected);
const ok = (value: unknown, msg?: string) => expect(value, msg).toBeTruthy();
const matches = (value: string, re: RegExp, msg?: string) => expect(value, msg).toMatch(re);
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TITLE_RE,
  decideRecurrenceHold,
  decideChronicEscalation,
  decideChronicDeescalation,
  countRecurrences,
  dropPhantomCancellations,
  alreadyRecurrenceHeld,
  recurrenceHoldNote,
  chronicEscalationNote,
  RECURRENCE_MARKER,
  RECURRENCE_HOLD_MARKER,
  CHRONIC_MARKER,
  CHRONIC_LABELS,
  DEFAULT_CHRONIC_RECURRENCES,
  DEFAULT_RECURRENCE_WINDOW_HOURS,
  DEFAULT_MAX_FAILURE_RATE,
} from '../scripts/ci/close-recovered-failure-issues.mjs';

const NOW = Date.parse('2026-08-18T08:00:00Z');
const opts = { now: NOW };

/** Una run completata, `minutesAgo` minuti fa. */
const run = (minutesAgo, ok) => ({
  databaseId: 100000 + minutesAgo,
  status: 'completed',
  conclusion: ok ? 'success' : 'failure',
  createdAt: new Date(NOW - minutesAgo * 60000).toISOString(),
});

/** Storico newest-first: `spec` è una lista [minutiFa, verde]. */
const history = (spec) => spec.map(([m, ok]) => run(m, ok));

/** Cadenza regolare: `count` run ogni `everyMin`, con i minuti in `failAt` rossi. */
function cadence({ count, everyMin, failAt = [] }) {
  const fails = new Set(failAt);
  return Array.from({ length: count }, (_, i) => run(i * everyMin, !fails.has(i * everyMin)));
}

// ── Il caso che ha aperto la scheda ───────────────────────────────────────────

test('storico con fallimenti ricorrenti + ultima run verde → la issue NON si chiude', () => {
  // La forma misurata su #249: il wedge colpisce ogni poche run, poi 3 verdi.
  const runs = history([
    [5, true], [12, true], [20, true],
    [35, false], [60, true], [90, false], [140, true], [200, false],
    [260, true], [320, true],
  ]);
  const d = decideRecurrenceHold(runs, opts);
  eq(d.hold, true, 'un guasto che ricorre non va chiuso perché l\'ultima run è verde');
  eq(d.failures, 3);
  eq(d.streak, 3);
  matches(d.reason, /RICORRE/);
});

test('storico pulito + ultima run verde → la issue si chiude', () => {
  // Il fallimento che ha aperto la issue è fuori dalla finestra recente e da
  // allora è solo verde: è il transitorio davvero rientrato, e la chiusura
  // automatica deve restare (è la ragione per cui il reconciler esiste).
  const runs = history([[5, true], [40, true], [80, true], [120, true], [600, false]]);
  const d = decideRecurrenceHold(runs, opts);
  eq(d.hold, false);
  eq(d.failures, 0);
  matches(d.reason, /transitorio rientrato/);
});

test('un solo fallimento nella finestra, seguito da 3 verdi → si chiude', () => {
  // È il fallimento che ha aperto la issue, non una ricorrenza: `maxRecurrences: 1`.
  const runs = history([[5, true], [25, true], [45, true], [70, false], [400, true]]);
  eq(decideRecurrenceHold(runs, opts).hold, false);
});

test('un solo fallimento ma appena UNA run verde dopo → si tiene aperta', () => {
  // Due delle 36 chiusure di #249 sono avvenute con l'ultima run completata
  // rossa (corsa fra il listing e la run in corso): la streak copre quel caso.
  const runs = history([[5, true], [70, false], [90, true], [400, true]]);
  const d = decideRecurrenceHold(runs, opts);
  eq(d.hold, true);
  eq(d.streak, 1);
});

test('19 verdi consecutive NON bastano se nella finestra il guasto è ricorso', () => {
  // Misurato: al momento di una delle auto-chiusure di #249 la streak era 19, e
  // il giorno dopo il wedge ha bruciato altre 12 run. La streak da sola non
  // discrimina niente — la misura che discrimina è il conteggio in finestra.
  const runs = [
    ...Array.from({ length: 19 }, (_, i) => run(5 + i * 8, true)),
    run(170, false), run(200, false), run(230, true),
  ];
  const d = decideRecurrenceHold(runs, opts);
  eq(d.streak, 19);
  eq(d.hold, true);
});

// ── Le famiglie che NON devono cambiare comportamento ─────────────────────────

test('workflow lento (cron giornaliero): un fallimento vecchio e una verde → si chiude come prima', () => {
  // La finestra di 8h è vuota: nessuna misura possibile e nessuna ragione di
  // tenere aperto. Senza questo ramo, `minGreenStreak: 3` su un cron giornaliero
  // vorrebbe dire tre giorni di issue aperta per un guasto già rientrato.
  const runs = history([[600, true], [2040, false], [3480, true]]);
  const d = decideRecurrenceHold(runs, opts);
  eq(d.hold, false);
  eq(d.sample, 0);
});

test('workflow ad alta cadenza: 2 flake su 120 run (1,7%) → la valvola sul tasso chiude', () => {
  // Una run ogni 4 minuti: senza valvola, due flake trascurabili basterebbero a
  // pinnare aperta una issue. La valvola NON copre #249: nei 36 momenti di
  // chiusura il suo tasso su 24h era al minimo 4,9% (mediana 12%).
  const runs = cadence({ count: 120, everyMin: 4, failAt: [300, 400] });
  const d = decideRecurrenceHold(runs, opts);
  eq(d.failures, 2);
  eq(d.sample, 120);
  ok(d.rate <= 0.02, `tasso misurato ${d.rate}`);
  eq(d.hold, false);
});

test('stessa cadenza al 5% di fallimenti → si tiene aperta', () => {
  const failAt = Array.from({ length: 6 }, (_, i) => 100 + i * 40);
  const runs = cadence({ count: 120, everyMin: 4, failAt });
  const d = decideRecurrenceHold(runs, opts);
  eq(d.failures, 6);
  eq(d.hold, true);
});

test('senza storico (crawler step) il gate è un no-op: comportamento invariato', () => {
  for (const empty of [null, undefined, []]) {
    const d = decideRecurrenceHold(empty, opts);
    eq(d.hold, false);
    eq(d.measured, false);
  }
});

// ── Escalation cronica ────────────────────────────────────────────────────────

const recurrenceComment = (hoursAgo) => ({
  body: `${RECURRENCE_MARKER} **Reopened** — ricorrenza`,
  createdAt: new Date(NOW - hoursAgo * 3600e3).toISOString(),
});

test('sotto soglia le ricorrenze non fanno escalation', () => {
  // Misurato sulle 22 issue di fallimento chiuse del repo: il massimo in 168h è
  // 3 (#411), poi 2 (#62) e 0 per le altre 19. La soglia a 5 non le tocca.
  const comments = [recurrenceComment(10), recurrenceComment(30), recurrenceComment(50)];
  const d = decideChronicEscalation(comments, opts);
  eq(d.hold, false);
  eq(d.count, 3);
  eq(d.threshold, DEFAULT_CHRONIC_RECURRENCES);
});

test('sopra soglia la issue è cronica: hold + escalation una volta sola', () => {
  const comments = Array.from({ length: 45 }, (_, i) => recurrenceComment(i * 3));
  const first = decideChronicEscalation(comments, opts);
  eq(first.hold, true);
  eq(first.escalate, true);
  eq(first.count, 45);

  // Secondo passaggio: il marker c'è già, niente label né commento ripetuti.
  const second = decideChronicEscalation(
    [...comments, { body: chronicEscalationNote({ workflow: 'X', decision: first }), createdAt: new Date(NOW).toISOString() }],
    opts,
  );
  eq(second.hold, true);
  eq(second.escalate, false);
});

test('le ricorrenze fuori finestra non contano', () => {
  const old = Array.from({ length: 40 }, (_, i) => recurrenceComment(200 + i));
  eq(countRecurrences(old, opts), 0);
  eq(decideChronicEscalation(old, opts).hold, false);
});

test('il commento di escalation non contiene 🔁: non deve gonfiare il proprio contatore', () => {
  const decision = { count: 45, threshold: 5, windowHours: 168 };
  const note = chronicEscalationNote({ workflow: 'Generate Blog Article', decision });
  ok(!note.includes(RECURRENCE_MARKER), 'il marker di ricorrenza è del reporter, non nostro');
  ok(note.includes(CHRONIC_MARKER));
  eq(countRecurrences([{ body: note, createdAt: new Date(NOW).toISOString() }], opts), 0);
  for (const label of CHRONIC_LABELS) ok(note.includes(label));
});

test('il commento di hold porta il conteggio, e si ripete solo dopo una nuova ricorrenza', () => {
  const decision = decideRecurrenceHold(
    history([[5, true], [12, true], [20, true], [35, false], [90, false]]),
    opts,
  );
  const note = recurrenceHoldNote({ workflow: 'Generate Blog Article', decision });
  ok(note.includes(RECURRENCE_HOLD_MARKER));
  ok(note.includes('2 fallimenti'), note);
  ok(!note.includes(RECURRENCE_MARKER));

  const held = [{ body: note, createdAt: new Date(NOW - 3600e3).toISOString() }];
  eq(alreadyRecurrenceHeld(held), true);
  // Se il guasto torna DOPO il nostro commento, il conteggio è cambiato e va riscritto.
  eq(alreadyRecurrenceHeld([...held, recurrenceComment(0.2)]), false);
  // Commenti illeggibili: si tiene comunque aperta, ma senza riscrivere il commento
  // a ogni passata oraria (non potremmo vedere il nostro stesso marker).
  eq(alreadyRecurrenceHeld(null), true);
});

// ── Il dedup sui titoli non si muove ─────────────────────────────────────────

test('TITLE_RE continua a riconoscere i titoli della famiglia', () => {
  for (const family of ['Workflow', 'Crawler', 'CI']) {
    const name = family === 'Crawler' ? 'Run grace' : 'Generate Blog Article';
    const title = `${family} Failure: ${name}`;
    const m = TITLE_RE.exec(title);
    ok(m, 'se il closer smette di riconoscere la issue, il difetto non viene né riparato né cancellato: viene ignorato');
    eq(m![1], name);
    // Il discriminante sta all'inizio, quindi la troncatura a 60 char del dedup
    // (DEDUP_TITLE_PREFIX_LEN in github-issue-creator.mjs) non lo taglia.
    ok(title.length <= 60);
    eq(TITLE_RE.exec(title.slice(0, 60))![1], name);
  }
});

// Qui NON c'è il gemello del grep su `scripts/ci/scan-failed-runs.mjs`: quello
// script è corpus-only (il corpus scansiona le run in un punto solo, questo repo
// apre le issue di fallimento con uno step dentro ognuno dei suoi ~135 workflow —
// vedi la voce `workflow-failure-issues.yml` del loop-sync-manifest). L'ancora
// che conta ed è portabile è quella sul marcatore 🔁 qui sotto: il reporter
// (`scripts/lib/github-issue-creator.mjs`) esiste identico da entrambi i lati.

test('i default sono quelli misurati', () => {
  eq(DEFAULT_RECURRENCE_WINDOW_HOURS, 8);
  eq(DEFAULT_CHRONIC_RECURRENCES, 5);
});

// ── Il marcatore di ricorrenza non si muove ─────────────────────────────────
//
// `RECURRENCE_MARKER` qui è una COPIA di una costante PRIVATA del reporter
// (`scripts/lib/github-issue-creator.mjs:75`). Un contratto senza forma di
// import: nessun guard che segue gli import lo vede. Se il reporter cambiasse
// marcatore, `countRecurrences()` tornerebbe 0 su ogni issue, il gate cronico
// diventerebbe un no-op silenzioso e la CI resterebbe verde. Stessa tecnica del
// grep che ancora il template del titolo qui sopra.
test('il marcatore 🔁 è ancora quello che il reporter scrive', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lib', 'github-issue-creator.mjs'),
    'utf8',
  );
  ok(
    src.includes(`const RECURRENCE_MARKER = '${RECURRENCE_MARKER}';`),
    'il reporter ha cambiato marcatore di ricorrenza: countRecurrences() conta 0 e il gate cronico muore in silenzio',
  );
  // Il marcatore deve comparire nei commenti che il reporter posta davvero, non
  // solo nella costante: sia la riapertura sia il commento su issue già aperta.
  ok(src.includes('${RECURRENCE_MARKER} Recurrence on workflow run.'), 'commento di ricorrenza su issue aperta');
  ok(src.includes('${RECURRENCE_MARKER} **Reopened**'), 'commento di riapertura');
});

// ── De-escalation: `needs-human` non è una porta a senso unico ──────────────
//
// `needs-human` è un filtro di ESCLUSIONE, non un selettore: followup-drainer.mjs
// lo legge per tenere una issue fuori dal pool dei retry parcheggiati (:1091) e
// fuori dal rescue `agent:fix` dei crawler (:1204). Se l'escalation lo applicasse
// senza mai toglierlo, una issue rientrata si richiuderebbe ma tornerebbe già
// esclusa da ogni coda alla riapertura successiva — per sempre.
const escalated = (n = NOW) => ({ body: `nota\n\n${CHRONIC_MARKER}`, createdAt: new Date(n - 7200e3).toISOString() });

test('rientrata sotto soglia: i label cronici vengono tolti', () => {
  const decision = decideChronicEscalation([escalated()], opts);
  eq(decision.hold, false, 'un solo commento senza 🔁 non è cronico');
  const d = decideChronicDeescalation({
    comments: [escalated()],
    labels: ['bug', 'priority:urgent', 'needs-human', 'fu-parked'],
    decision,
  });
  eq(d.clear, true);
  deepEq(d.labels, ['priority:urgent', 'needs-human']);
});

test('ancora cronica: non si tocca niente', () => {
  const comments = [escalated(), ...Array.from({ length: 6 }, (_, i) => recurrenceComment(i + 1))];
  const decision = decideChronicEscalation(comments, opts);
  eq(decision.hold, true);
  eq(decideChronicDeescalation({ comments, labels: CHRONIC_LABELS.slice(), decision }).clear, false);
});

test('label già assenti: nessuna chiamata gh sprecata a ogni passata oraria', () => {
  const comments = [escalated()];
  const decision = decideChronicEscalation(comments, opts);
  // Il CHRONIC_MARKER resta nel thread per sempre: senza il controllo sui label
  // presenti, ogni passata rifarebbe `gh issue edit` su una issue già pulita.
  eq(decideChronicDeescalation({ comments, labels: ['bug'], decision }).clear, false);
});

test('mai escalata: la de-escalation non tocca label messi da altri', () => {
  // `needs-human` arriva anche dal followup-drainer (too-large). Toglierlo senza
  // aver visto il NOSTRO marker vorrebbe dire disfare la decisione di un altro
  // strato del ciclo.
  const comments = [{ body: 'un commento qualsiasi', createdAt: new Date(NOW - 3600e3).toISOString() }];
  const decision = decideChronicEscalation(comments, opts);
  eq(decideChronicDeescalation({ comments, labels: ['needs-human'], decision }).clear, false);
});

test('commenti illeggibili: non si toglie niente', () => {
  const decision = decideChronicEscalation(null, opts);
  eq(decideChronicDeescalation({ comments: null, labels: CHRONIC_LABELS.slice(), decision }).clear, false);
});

// ── La famiglia `Crawler Failure:` NON è esente dal gate cronico ────────────
//
// #413 aveva dichiarato che quella famiglia non cambiava comportamento, ma la
// dichiarazione copriva il solo gate di ricorrenza (no-op per costo: uno storico
// di run per step di background costerebbe una chiamata Jobs API per run). Il
// gate cronico legge i COMMENTI e costa uguale per tutte le famiglie, quindi si
// applica anche ai crawler — misurato sulla famiglia, non presunto.
//
// FIXTURE MISURATA: sito #5139 `Crawler Failure: Run grace`, 6 commenti 🔁 fra il
// 2026-08-15T21:57:39Z e il 2026-08-18T09:55:55Z (letti con
// `gh api repos/valerielinc-ops/frontaliere-si-o-no/issues/5139/comments --paginate`).
const CRAWLER_5139_RECURRENCES = [
  '2026-08-15T21:57:39Z',
  '2026-08-16T09:45:42Z',
  '2026-08-16T21:56:32Z',
  '2026-08-17T10:02:23Z',
  '2026-08-17T21:48:29Z',
  '2026-08-18T09:55:55Z',
].map((createdAt) => ({ body: `${RECURRENCE_MARKER} Recurrence on workflow run.`, createdAt }));

test('#5139 (crawler) è cronica: il gate NON è un no-op su quella famiglia', () => {
  const now = Date.parse('2026-08-18T10:00:00Z');
  eq(countRecurrences(CRAWLER_5139_RECURRENCES, { now }), 6);
  const decision = decideChronicEscalation(CRAWLER_5139_RECURRENCES, { now });
  eq(decision.hold, true, 'una issue crawler cronica non si auto-chiude più');
  eq(decision.count, 6);
  eq(decision.threshold, 5);
});

test('la soglia 5 resta selettiva sulla famiglia crawler', () => {
  // Campione delle 60 issue `Crawler Failure:` chiuse più recenti del sito
  // (2026-08-18): massimo mobile a 168h = 0 per 54/60, poi 1, 2, 2, 4, 6, 9.
  // Bimodale, stacco fra 2 e 4: a 5 il gate scatta su 2/60 e non sulla coda.
  const now = Date.parse('2026-08-18T10:00:00Z');
  const sample = (n) => Array.from({ length: n }, (_, i) => ({
    body: RECURRENCE_MARKER,
    createdAt: new Date(now - (i + 1) * 12 * 3600e3).toISOString(),
  }));
  for (const n of [0, 1, 2, 4]) {
    eq(decideChronicEscalation(sample(n), { now }).hold, false, `${n} ricorrenze non è cronica`);
  }
  for (const n of [6, 9]) {
    eq(decideChronicEscalation(sample(n), { now }).hold, true, `${n} ricorrenze è cronica`);
  }
});

// ── #5333: la cancellazione a job-zero non è un fallimento ────────────────────
//
// `tests` su push-a-main gira con `cancel-in-progress: false`, ma GitHub tiene un
// solo run PENDING per gruppo e scarta il pending superato a ogni push successivo:
// esce una run `cancelled` che non ha mai eseguito un job. Contarla come fallimento
// gonfia il tasso e pinna aperta la issue. Il discriminante è `total_count` dei job:
// zero = scartata in coda; >0 = ha lavorato, e in particolare il TIMEOUT
// (`timeout-minutes`) esce anch'esso `cancelled` — è la premessa di
// `scan-job-timeouts.mjs` — ed è il guasto che ha riaperto #5333.

/** Una run `cancelled` (non `failure`): distingue lo scarto in coda dal test rosso. */
const cancelledRun = (minutesAgo, databaseId) => ({
  databaseId,
  status: 'completed',
  conclusion: 'cancelled',
  createdAt: new Date(NOW - minutesAgo * 60000).toISOString(),
});

/** `isPhantom` finto: job-zero per gli id elencati, e conta le chiamate. */
const phantomOracle = (jobZeroIds) => {
  const calls: number[] = [];
  const fn = (id) => {
    calls.push(id);
    return jobZeroIds.includes(id);
  };
  fn.calls = calls;
  return fn;
};

test('una cancellazione a job-zero esce dallo storico; una con job resta', () => {
  const phantom = cancelledRun(10, 901);
  const timedOut = cancelledRun(20, 902); // job cancellato da `timeout-minutes`
  const runs = [phantom, timedOut, run(30, true)];
  const isPhantom = phantomOracle([901]);

  const kept = dropPhantomCancellations(runs, isPhantom);
  deepEq(kept.map((r) => r.databaseId), [902, 100030]);
  // Il costo si paga solo sulle righe `cancelled`: la run verde non viene interrogata.
  deepEq(isPhantom.calls, [901, 902]);
});

test('senza il filtro la cancellazione a job-zero conta come fallimento', () => {
  // Il controfattuale esplicito: è la riga che il gate contava PRIMA della fix.
  const runs = [run(5, true), run(15, true), run(25, true), cancelledRun(35, 901)];
  eq(decideRecurrenceHold(runs, opts).failures, 1, 'un `cancelled` non è `success`');
  const filtered = dropPhantomCancellations(runs, phantomOracle([901]));
  eq(decideRecurrenceHold(filtered, opts).failures, 0);
});

test('un timeout NON viene filtrato: resta un fallimento misurato', () => {
  // La regressione da temere è l'opposta della fix: filtrare tutti i `cancelled`
  // (come fa `loop-health-report.mjs` con `real = total - cancelled - skipped`)
  // renderebbe il gate cieco proprio ai timeout — cioè a #5333.
  const runs = [
    run(5, true), run(15, true), run(25, true),
    cancelledRun(35, 902), cancelledRun(60, 903), cancelledRun(90, 904),
  ];
  const filtered = dropPhantomCancellations(runs, phantomOracle([])); // nessuno job-zero
  const d = decideRecurrenceHold(filtered, opts);
  eq(d.sample, 6, 'i timeout restano nel denominatore');
  eq(d.failures, 3);
  eq(d.hold, true, 'tre timeout in 8h sono un guasto che ricorre, non rumore');
});

test('oracolo non disponibile → la run resta (PROCEED-SAFE, bias verso l\'hold)', () => {
  // `hasNoJobs` torna `false` su errore gh/API: non esclude nulla.
  const runs = [run(5, true), cancelledRun(35, 901)];
  deepEq(dropPhantomCancellations(runs, () => false).length, 2);
  deepEq(dropPhantomCancellations(null as never, () => true), []);
});

test('#5333: lo storico misurato di `tests` passa da hold a chiusura', () => {
  // Dati veri, non inventati: `gh run list -w tests -b main -L 100`, finestra di 8h
  // che precede il commento di hold del 2026-08-18T14:56:48Z. `s` = success,
  // `c` = cancelled; tutte e 5 le `c` hanno `total_count: 0` (misurato una per una
  // con `gh api .../actions/runs/<id>/jobs?per_page=1`).
  const MEASURED: Array<[number, string]> = [
    [28, 's'], [40, 's'], [47, 'c'], [68, 's'], [81, 's'], [92, 's'], [104, 's'],
    [123, 's'], [135, 's'], [141, 'c'], [148, 's'], [153, 'c'], [161, 's'], [180, 's'],
    [215, 's'], [222, 'c'], [231, 's'], [247, 's'], [264, 'c'], [264, 's'], [328, 's'],
    [554, 's'], [994, 's'], [1073, 's'], [1115, 's'], [1279, 's'],
  ];
  const jobZero: number[] = [];
  const runs = MEASURED.map(([m, c], i) => {
    const databaseId = 700000 + i;
    if (c === 'c') jobZero.push(databaseId);
    return { databaseId, status: 'completed', conclusion: c === 's' ? 'success' : 'cancelled',
      createdAt: new Date(NOW - m * 60000).toISOString() };
  });

  // PRIMA: è esattamente il commento postato sulla issue.
  const before = decideRecurrenceHold(runs, opts);
  eq(before.failures, 5);
  eq(before.sample, 21);
  eq(before.streak, 2);
  eq((before.rate * 100).toFixed(1), '23.8');
  eq(before.hold, true);

  // DOPO: nessun fallimento reale nella finestra → transitorio rientrato.
  const after = decideRecurrenceHold(dropPhantomCancellations(runs, phantomOracle(jobZero)), opts);
  eq(after.failures, 0);
  eq(after.sample, 16);
  eq(after.hold, false);
  matches(after.reason, /transitorio rientrato/);
});

test('denominatore che si restringe: il tasso diventa più volatile, non più permissivo', () => {
  // Effetto collaterale reale della fix, da conoscere: su un workflow molto
  // cancellato (`Deploy to GitHub Pages`, 91/100 righe `cancelled` su main il
  // 2026-08-18) il campione crolla, e un solo fallimento vero può superare la
  // valvola del 2%. Il filtro NON è una scorciatoia verso la chiusura.
  const noisy = [
    run(5, true), run(20, true), run(35, true),
    ...Array.from({ length: 40 }, (_, i) => cancelledRun(50 + i * 5, 800 + i)),
    run(300, false),
  ];
  const jobZero = Array.from({ length: 40 }, (_, i) => 800 + i);
  const before = decideRecurrenceHold(noisy, opts);
  eq(before.sample, 44);
  eq(before.failures, 41, '40 scarti in coda + 1 fallimento vero, indistinguibili');
  eq(before.hold, true, 'un workflow sano risulterebbe rotto al 93%');

  const d = decideRecurrenceHold(dropPhantomCancellations(noisy, phantomOracle(jobZero)), opts);
  eq(d.sample, 4, 'il campione crolla da 44 a 4: il tasso resta misurabile ma volatile');
  eq(d.failures, 1);
  eq(d.hold, false, 'un solo fallimento con 3 verdi dopo resta un transitorio (maxRecurrences)');
  ok(d.rate > DEFAULT_MAX_FAILURE_RATE, `1/4 = ${d.rate} sfonda la valvola del 2%: a chiudere è maxRecurrences, non il tasso`);
});
