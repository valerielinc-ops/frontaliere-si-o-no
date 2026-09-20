#!/usr/bin/env node
/**
 * failure-issue-inventory.mjs — chi APRE una issue di fallimento, e chi la CHIUDE.
 *
 * ─── Perché esiste ───────────────────────────────────────────────────────
 *
 * Le due metà — apertura su rosso e chiusura sul verde — sono accoppiate, e
 * l'accoppiamento non ha forma di import: nessun guard che segue gli import lo
 * vede, e la CI resta verde mentre una issue diventa immortale. Col dedup sul
 * titolo (primi 60 char, scripts/lib/github-issue-creator.mjs) una issue che
 * nessun chiuditore riconosce non si chiude MAI: la stessa condizione che
 * rifallisce ci commenta sopra `🔁 Recurrence`, e il verde non la tocca.
 *
 * È successo due volte in forme diverse:
 *   - `alert-pat-down.mjs` (#5432) dichiarava in un COMMENTO un «unico punto di
 *     chiusura» che non esisteva. Il commento sembrava coprire il caso.
 *   - `rerender-article-hubs` / `rerender-article-corpus` (#5470) aprivano
 *     `<workflow> (<section>) failed`, titolo fuori da entrambi i chiuditori del
 *     repo. Nemmeno il commento sbagliato: mancava proprio la metà.
 *
 * Questo modulo rende l'accoppiamento ENUMERABILE, quindi verificabile:
 * `tests/failure-issue-closers.test.ts` ci costruisce sopra il gate, e da riga
 * di comando stampa l'inventario per decidere il prossimo workflow da adottare
 * (issue #5437).
 *
 * ─── I chiuditori che esistono, e sono tutti qui ─────────────────────────
 *
 *   1. `scripts/ci/close-recovered-failure-issues.mjs` — cron centrale. Chiude
 *      i titoli che matchano il suo `TITLE_RE` (`Workflow|Crawler|CI Failure:
 *      <nome>`) quando il run successivo di `<nome>` è verde. `<nome>` va
 *      risolto da `gh run list -w <nome>`, quindi DEVE essere il `name:` del
 *      workflow: un mismatch (l'unico noto è persist-job-stats) è indistinguibile
 *      da "coperto" a occhio, e non chiude niente.
 *   2. `scripts/ci/report-validate-dist-failure.mjs --mode resolve` — chiude i
 *      `Validation Failure (dist): …`, tenuti fuori dal TITLE_RE di proposito.
 *   3. Uno step gemello `--resolve` (o questa stessa composite action con
 *      `mode: resolve`) NELLO STESSO workflow, con titolo IDENTICO — modello
 *      `rpm-canary.yml`, step "Resolve open issue on green".
 *
 * Non ce ne sono altri. Se un titolo non ricade in nessuno dei tre, nessuno lo
 * chiude: è un fatto, non una stima.
 *
 * ─── Cosa NON vede (dichiarato, non nascosto) ────────────────────────────
 *
 * - Solo `.github/workflows/**`. Gli opener lato script (`createGithubIssue({
 *   title })` dentro `scripts/**`) hanno titoli COMPUTATI, spesso da funzioni:
 *   un'analisi testuale li leggerebbe male, e leggerli male è peggio che non
 *   leggerli.
 * - Solo i titoli LETTERALI (o assegnati a una variabile shell nello stesso
 *   file). Un titolo che arriva dall'output di un altro step è irrisolvibile.
 * - Non prova che il chiuditore FUNZIONI a runtime: prova che esiste e che il
 *   titolo ricade nel suo pattern. Un workflow rinominato senza aggiornare il
 *   titolo passa questo controllo e non si chiude lo stesso.
 *
 * ─── Uso ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/ci/failure-issue-inventory.mjs            # riepilogo + scoperti
 *   node scripts/ci/failure-issue-inventory.mjs --all      # ogni titolo, con chi lo chiude
 *   node scripts/ci/failure-issue-inventory.mjs --json     # per un altro script
 *
 * Sempre exit 0: è un inventario, non un gate. Il gate è il test.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TITLE_RE } from './close-recovered-failure-issues.mjs';
import { TITLE_PREFIX } from './report-validate-dist-failure.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/** Il path della composite action, come compare in un `uses:`. */
export const REPORT_ACTION_USES = './.github/actions/report-failure';

/* ── parsing ─────────────────────────────────────────────────────────── */

/**
 * Blocchi step di un workflow: da una riga `- name: …` alla successiva.
 *
 * Deliberatamente testuale e non un parser YAML: serve la RIGA di ogni step per
 * dire dove intervenire, e un parser perderebbe i commenti che in questo repo
 * portano metà del contratto.
 */
export function stepBlocks(source) {
  const lines = String(source).split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    if (/^\s*-\s+name:\s*\S/.test(l)) starts.push(i);
  });
  return starts.map((a, k) => {
    const b = k + 1 < starts.length ? starts[k + 1] : lines.length;
    return { line: a + 1, text: lines.slice(a, b).join('\n') };
  });
}

/**
 * I `name:` dei workflow OSSERVATI via `on: workflow_run: workflows: [...]`.
 *
 * Testuale come il resto del modulo, e ancorato al blocco `workflow_run:`: la
 * lista può stare in flow (`['A', 'B']`) o in block (`- 'A'`). È l'unica cosa
 * che serve sapere, perché per il reconciler centrale conta solo che il nome
 * nel titolo sia risolvibile da `gh run list -w <nome>` — e un workflow
 * dichiarato qui esiste per costruzione, altrimenti GitHub rifiuterebbe il
 * file (`workflow_run` con una lista vuota o assente è un file INVALIDO,
 * #6656).
 *
 * @param {string} source
 * @returns {string[]}
 */
export function observedWorkflowNames(source) {
  const text = String(source);
  const head = text.match(/^([ \t]*)workflow_run:[ \t]*$/m);
  if (!head) return [];
  // SOLO il blocco indentato sotto `workflow_run:`. Cercare nel resto del file
  // lascerebbe agganciare una chiave `workflows:` di un'altra sezione — per
  // esempio un input di `workflow_dispatch` — e `coverageOf` leggerebbe come
  // «osservato» un nome che non lo è: cioè il caso peggiore, un titolo che
  // SEMBRA coperto mentre `gh run list -w` non risolve niente.
  const indent = head[1].length;
  const lines = text.slice(head.index + head[0].length).split('\n');
  const body = [];
  for (const line of lines) {
    if (line.trim() === '' || /^\s*#/.test(line)) { body.push(line); continue; }
    if (line.match(/^[ \t]*/)[0].length <= indent) break;
    body.push(line);
  }
  const rest = body.join('\n');
  const flow = rest.match(/^\s*workflows:\s*\[(.+?)\]\s*$/m);
  if (flow) {
    return flow[1].split(',')
      .map((v) => v.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  const block = rest.match(/^(\s*)workflows:\s*$((?:\r?\n\s*-\s*.+)+)/m);
  if (block) {
    return block[2].split('\n')
      .map((l) => l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return [];
}

/** Assegnazioni shell `NAME="value"` su riga singola, per risolvere `--title "$VAR"`. */
function shellAssignments(source) {
  const map = new Map();
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"\s*$/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    const list = map.get(m[1]) ?? [];
    list.push(m[2]);
    map.set(m[1], list);
  }
  return map;
}

/**
 * Titoli letterali di una lista `for VAR in "a" "b"; do … --title "$VAR" … done`.
 *
 * Non è un caso di scuola: `deploy.yml` chiude DUE titoli con un solo step
 * scritto così. Senza questo ramo quei due risultano scoperti mentre il loro
 * chiuditore è lì — e un inventario che grida al lupo su un caso coperto smette
 * di essere letto, che è il modo più veloce per far tornare vero il difetto.
 */
function loopLiterals(stepText, varName) {
  const m = String(stepText).match(new RegExp(`\\bfor\\s+${varName}\\s+in\\b([\\s\\S]*?)\\bdo\\b`));
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

/**
 * `--title "$VAR"` → i valori letterali che `$VAR` può avere.
 *
 * Le assegnazioni dello STEP vincono su quelle del file: `cathedral-seo-gates-check.yml`
 * assegna `title=` in due step diversi, e una risoluzione file-wide attribuiva a
 * ciascuno anche il titolo dell'altro — con l'effetto di far risultare
 * failure-gated un titolo aperto da uno step che failure-gated non è.
 */
function expandTitle(raw, fileAssignments, stepText = '') {
  const v = String(raw).match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (!v) return [String(raw)];
  const local = shellAssignments(stepText).get(v[1]);
  if (local) return local;
  const assigned = fileAssignments.get(v[1]);
  if (assigned) return assigned;
  return loopLiterals(stepText, v[1]);
}

/**
 * Uno step apre una issue "perché il run è fallito" (e non "perché ha misurato
 * una condizione")? Solo per questi la chiusura corretta è "sul prossimo verde",
 * ed è questa la popolazione di cui #5437 si occupa. Un monitor che apre su un
 * run VERDE avendo trovato uno stato brutto ha un ciclo di vita diverso e non
 * viene giudicato qui.
 */
export function isFailureGated(stepText) {
  const cond = ifConditionText(stepText);
  return /failure\(\)/.test(cond)
    || /outcome\s*==\s*'failure'/.test(cond)
    || /result\s*==\s*'failure'/.test(cond)
    || WORKFLOW_RUN_FAILURE_GATE.test(cond);
}

/**
 * La condizione di un `if:`, anche quando è scritta su più righe.
 *
 * `if: >-` (folded) e `if: |` (literal) sono la forma normale appena la
 * condizione supera una riga, e la lettura inline le vedeva come la stringa
 * `>-`: cioè NESSUNA condizione. Un opener con un `if:` multi-riga risultava
 * quindi non-failure-gated e usciva dall'inventario — un buco silenzioso nel
 * gate, non una scelta. Misurato sul repo: 21 `if:` in forma block, di cui 5
 * failure-gated, e nessuno di quei 5 era visibile prima.
 *
 * @param {string} stepText
 * @returns {string} la condizione su una riga sola, o '' se non c'è `if:`
 */
export function ifConditionText(stepText) {
  const lines = String(stepText).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/^(\s*)if:\s*(\S.*)$/);
    if (!inline) continue;
    // `>-`, `|`, ma anche `>2-` / `|1+`: l'indicatore di indentazione è YAML
    // valido e senza questa cifra la condizione verrebbe letta come il testo
    // `>2-`, cioè NESSUNA condizione, e l'opener uscirebbe dall'inventario in
    // silenzio — lo stesso buco che questa funzione è nata per chiudere.
    if (!/^[>|]\d?[-+]?$/.test(inline[2].trim())) return inline[2];
    // Block scalar: le righe più rientrate dell'`if:` sono il corpo.
    const indent = inline[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') { body.push(''); continue; }
      if (lines[j].match(/^\s*/)[0].length <= indent) break;
      body.push(lines[j].trim());
    }
    return body.join(' ').trim();
  }
  return '';
}

/**
 * Il gate di un osservatore CROSS-WORKFLOW: uno step che apre su
 * `github.event.workflow_run.conclusion == 'failure'`, cioè sul rosso di un
 * ALTRO workflow, non del proprio run.
 *
 * Perché l'inventario deve vederlo. Un reporter che vive dentro il workflow
 * osservato non può segnalare un guasto che impedisce al suo job di partire:
 * se il rosso è a monte, il job che lo ospita non è rosso, è `skipped`, e un
 * `if: failure()` di un job saltato non viene mai valutato. È ciò che ha
 * lasciato `Deploy to GitHub Pages` rosso per 10h24m il 2026-09-19 con tutti i
 * suoi reporter regolarmente montati — dentro `build-locale`, saltato. La
 * risposta è un osservatore esterno, e un osservatore esterno che APRE una
 * issue ha esattamente lo stesso obbligo di chiusura di ogni altro opener:
 * senza questa riga sarebbe l'unica famiglia di opener invisibile al gate di
 * `tests/failure-issue-closers.test.ts`.
 *
 * Volutamente ANCORATA alla forma completa `github.event.workflow_run.…`: un
 * `conclusion == 'failure'` nudo matcherebbe anche `steps.<id>.conclusion`,
 * che è un'altra cosa e che gli step del repo scrivono sempre insieme a
 * `failure()` (verificato: cinque file, tutti già inventariati).
 */
export const WORKFLOW_RUN_FAILURE_GATE =
  /github\.event\.workflow_run\.conclusion\s*==\s*'(?:failure|timed_out|startup_failure)'/;

/** Valore di un input `with:` (letterale, con o senza apici). */
function withInput(stepText, name) {
  const re = new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm');
  const m = String(stepText).match(re);
  if (!m) return null;
  let v = m[1].trim();
  // `>-` / `|` a capo: valore multilinea, non un titolo — ignorato.
  if (/^[|>][-+]?$/.test(v)) return null;
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    v = v.slice(1, -1);
  }
  return v;
}

/**
 * Opener e closer dichiarati da UN workflow.
 *
 * @returns {{ file: string, workflowName: string,
 *             openers: {title: string, rawTitle: string, line: number, failureGated: boolean, closedBy: string|null, via: 'shell'|'action'}[],
 *             closers: {title: string, line: number, via: 'shell'|'action'}[] }}
 */
export function parseWorkflow(source, file) {
  const nameMatch = String(source).match(/^name:\s*(.+)$/m);
  const workflowName = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const observedWorkflows = observedWorkflowNames(source);
  const assignments = shellAssignments(source);
  const openers = [];
  const closers = [];

  const norm = (t) => t.replace(/\$\{\{\s*github\.workflow\s*\}\}/g, workflowName);

  for (const block of stepBlocks(source)) {
    const usesAction = block.text.includes(REPORT_ACTION_USES);
    if (usesAction) {
      const title = withInput(block.text, 'title');
      if (!title) continue;
      const mode = withInput(block.text, 'mode') || 'report';
      const entry = { title: norm(title), rawTitle: title, line: block.line, via: 'action' };
      if (mode === 'resolve') closers.push(entry);
      else {
        openers.push({
          ...entry,
          failureGated: isFailureGated(block.text),
          closedBy: withInput(block.text, 'closed-by'),
        });
      }
      continue;
    }
    if (!block.text.includes('github-issue-creator.mjs')) continue;
    const isResolve = /--resolve\b/.test(block.text);
    const failureGated = isFailureGated(block.text);
    for (const m of block.text.matchAll(/--title\s+"([^"]*)"/g)) {
      for (const raw of expandTitle(m[1], assignments, block.text)) {
        const entry = { title: norm(raw), rawTitle: raw, line: block.line, via: 'shell' };
        if (isResolve) closers.push(entry);
        else openers.push({ ...entry, failureGated, closedBy: null });
      }
    }
  }
  return { file, workflowName, observedWorkflows, openers, closers };
}

export function inventory(dir = WORKFLOWS_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => parseWorkflow(fs.readFileSync(path.join(dir, f), 'utf8'), f));
}

/* ── copertura ───────────────────────────────────────────────────────── */

/**
 * Chi chiude questo opener, o `null` se nessuno.
 *
 * L'ordine è quello del costo: prima i due chiuditori centrali (nessun codice
 * per workflow), poi lo step gemello locale.
 *
 * @returns {{ by: string, detail?: string } | null}
 */
export function coverageOf(opener, record) {
  const m = TITLE_RE.exec(opener.title);
  if (m) {
    const named = m[1].trim();
    // Il reconciler fa `gh run list -w <named>`: la domanda non è "chi ha
    // scritto la issue" ma "quel nome risolve a un workflow reale". Risolve in
    // DUE casi, non uno:
    //   - il workflow parla di se stesso (`name:` proprio);
    //   - il workflow è un OSSERVATORE e parla del workflow che osserva, cioè
    //     di un nome dichiarato nel proprio `on: workflow_run: workflows:`.
    // Il secondo caso è quello di un reporter esterno, l'unico che può vedere
    // un guasto a monte del build — dove il job che ospiterebbe un reporter
    // interno risulta `skipped` e il suo `if: failure()` non viene valutato.
    // Fuori da questi due il titolo NON risolve: `close-recovered-failure-issues`
    // lo prende in carico, non trova run, e per bias conservativo lascia la
    // issue aperta. Per sempre, in silenzio — il caso peggiore, perché a occhio
    // sembra coperto.
    const observed = Array.isArray(record.observedWorkflows) ? record.observedWorkflows : [];
    if (named === record.workflowName || observed.includes(named)) {
      return { by: 'close-recovered-failure-issues' };
    }
    return { by: 'close-recovered-failure-issues', detail: `nome nel titolo "${named}" ≠ name: "${record.workflowName}" e non è fra i workflow osservati → gh run list -w non risolve` };
  }
  if (opener.title.startsWith(TITLE_PREFIX.trimEnd())) {
    return { by: 'report-validate-dist-failure' };
  }
  if (record.closers.some((c) => c.title === opener.title)) {
    return { by: 'sibling-resolve-step' };
  }
  return null;
}

/** Ogni opener failure-gated, con il suo chiuditore (o `null`). */
export function coverageReport(dir = WORKFLOWS_DIR) {
  const rows = [];
  for (const rec of inventory(dir)) {
    for (const op of rec.openers) {
      if (!op.failureGated) continue;
      const cov = coverageOf(op, rec);
      rows.push({
        file: rec.file,
        line: op.line,
        title: op.title,
        via: op.via,
        declaredClosedBy: op.closedBy,
        closedBy: cov ? cov.by : null,
        detail: cov?.detail ?? null,
      });
    }
  }
  // Ordine stabile: il test ci confronta un baseline letterale.
  return rows.sort((a, b) => (a.file + a.title).localeCompare(b.file + b.title));
}

/* ── CLI ─────────────────────────────────────────────────────────────── */

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const rows = coverageReport();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    process.exit(0);
  }
  const uncovered = rows.filter((r) => !r.closedBy);
  const adopted = rows.filter((r) => r.via === 'action');
  const all = process.argv.includes('--all');
  if (all) {
    for (const r of rows) {
      console.log(`${r.closedBy ? '✅' : '❌'} ${r.file}:${r.line}\t${r.title}\t→ ${r.closedBy || 'NESSUNO'}${r.detail ? ` (${r.detail})` : ''}`);
    }
    console.log('');
  }
  console.log(`issue di fallimento aperte da un ramo failure(): ${rows.length}`);
  console.log(`  con un chiuditore: ${rows.length - uncovered.length}`);
  console.log(`  SENZA chiuditore:  ${uncovered.length}`);
  console.log(`  già sul reporter diagnostico (${REPORT_ACTION_USES}): ${adopted.length}`);
  if (!all && uncovered.length > 0) {
    console.log('\nSenza chiuditore — adottarne uno PRIMA di montarci il reporter (#5437):');
    for (const r of uncovered) console.log(`  ${r.file}:${r.line}\t${r.title}`);
  }
  process.exit(0);
}
