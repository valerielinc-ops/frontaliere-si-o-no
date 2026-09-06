#!/usr/bin/env node
/**
 * gate-minted-followups.mjs — gate DETERMINISTICO in ingresso sul conio delle follow-up.
 *
 * Il problema che chiude. `post-merge-followup.yml` conia una issue aggregata per PR
 * mergiata. Il divieto di mintare item senza condizione di accettazione falsificabile
 * esiste già, ma vive SOLO nel prompt Claude (`FOLLOWUP.md` → «Hard-exclude:
 * no-acceptance-condition»): è una richiesta a un LLM, non un invariante. Misurato il
 * 2026-09-06 sul sito, ultimi 7 giorni: 164 aggregate coniate, 91 (55% = 13,0/giorno)
 * strutturalmente immortali — 76 senza NEMMENO un item con condizione falsificabile
 * (`no-valid-item`) e 15 con un corpo che non si lascia spezzare in item
 * (`aggregate-unparsed`). Una `no-valid-item` non si chiude mai: `aggregateCloseGate()`
 * la blocca per costruzione (chiuderla sarebbe chiudere su evidenza assente, incidente
 * #5849), e nessun umano arriva. Nasce già morta e resta in coda per sempre.
 *
 * Cosa fa, dopo il conio e a zero-Claude:
 *   - rilegge il corpo della issue appena creata e lo spezza con `splitFollowupItems()`;
 *   - DEMOTE gli item che non passano `hasFalsifiableAcceptance()`: li toglie dal corpo
 *     (rinumerando i superstiti) e li riscrive nel commento di summary della PR, dove
 *     restano leggibili — esattamente il trattamento già riservato ai `Live-verification`;
 *   - SOPPRIME la issue (close + citazione) quando non resta nessun item valido: quella
 *     issue non sarebbe mai potuta uscire dalla coda.
 *
 * DIREZIONE DI SICUREZZA (il vincolo centrale di #7587). Il criterio in ingresso è lo
 * STESSO oracolo che chiude l'item, importato verbatim da `followup-resolution-match.mjs`
 * e mai reimplementato qui: usarne uno più PERMISSIVO in apertura è precisamente ciò che
 * ha prodotto la coda immortale. Non nasce nessun predicato nuovo. E la soglia del token
 * (`isDistinctiveToken()`) NON si tocca: allentarla è stato misurato e ritirato il
 * 2026-09-06 — ammetteva +93 item, ma 32 dei 45 nuovi verificabili (71%) portavano un
 * token GIA' presente nel file citato, cioè `detectAlreadyResolved()` avrebbe letto
 * «fatto» su lavoro pendente (classe #1647, REVIEW.md L92).
 *
 * IL PREZZO, dichiarato. Un item demoto che era lavoro vero esce dal tracciamento e
 * sopravvive solo nel commento della PR. Succede: #7646 item 1 cita due path e
 * `CRAWLER_GENERATION_TOKEN` ma nudi, fuori da una riga `Suggested action`; #6192 item 1
 * cita `SYSTEMIC_RATE_CEILING` e `post-deploy-validate-dist.yml`. Il verso è deliberato:
 * un item che nessun check potrà mai dichiarare affrontato non è lavoro tracciabile ma un
 * promemoria, e 13 promemoria al giorno in coda hanno un costo che si misura.
 *
 * PROCEED-SAFE / TOTALE: qualunque errore su una issue (parse, rete, gh) è swallowed e
 * lascia la issue INTATTA. Un corpo senza struttura a item (`splitFollowupItems() === []`)
 * non viene MAI soppresso: «non so leggerlo» non è «è vuoto» (stessa regola di
 * `aggregateCloseGate`).
 *
 * Env:
 *   BATCH_PRS       csv dei numeri di PR triagiati (output di collect-followup-batch).
 *   GH_REPO         `owner/repo` (default: inferito da gh).
 *   GH_TOKEN        richiesto per le scritture.
 *   DRY_RUN         "1" → stampa il verdetto, nessuna scrittura.
 *   GATE_MAX_AGE_MIN  età massima (minuti) della issue su cui agire (default 240). Un
 *                   backfill via workflow_dispatch su una PR vecchia non deve poter
 *                   riscrivere una issue che nel frattempo un umano ha curato.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFalsifiableAcceptance, splitFollowupItems } from './followup-resolution-match.mjs';
import { intFromEnv } from '../lib/int-from-env.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const MAX_AGE_MIN = intFromEnv('GATE_MAX_AGE_MIN', 240);
export const MINT_GATE_MARKER = '<!-- followup-mint-gate -->';

/**
 * Spezza il corpo coniato in testa + item, e partiziona gli item con l'oracolo
 * condiviso. Puro.
 *
 * @param {string} body
 * @returns {{ head: string, valid: string[], demoted: string[], unparsed: boolean }}
 */
export function partitionMintedItems(body) {
  const src = String(body || '');
  const items = splitFollowupItems(src);
  if (!items.length) return { head: src, valid: [], demoted: [], unparsed: true };
  const head = src.split(/^### \d+\./m)[0];
  const valid = [];
  const demoted = [];
  for (const it of items) (hasFalsifiableAcceptance(it) ? valid : demoted).push(it);
  return { head, valid, demoted, unparsed: false };
}

/**
 * Verdetto per una issue appena coniata. Puro — nessuna I/O, così il test lo esercita
 * senza rete.
 *
 * @param {{body: string, createdAt?: string}} issue
 * @param {{now?: number, maxAgeMin?: number}} [opts]
 * @returns {{ action: 'suppress'|'demote'|'keep'|'skip', reason: string,
 *             valid: string[], demoted: string[], body: string|null }}
 */
export function decideMintGate(issue, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeMin = opts.maxAgeMin ?? MAX_AGE_MIN;
  const createdAt = issue?.createdAt ? Date.parse(issue.createdAt) : NaN;
  if (Number.isFinite(createdAt) && now - createdAt > maxAgeMin * 60_000) {
    return { action: 'skip', reason: 'not-freshly-minted', valid: [], demoted: [], body: null };
  }
  const { head, valid, demoted, unparsed } = partitionMintedItems(issue?.body || '');
  // «Non so leggerlo» non è «è vuoto»: un corpo senza struttura a item resta intatto.
  if (unparsed) return { action: 'skip', reason: 'aggregate-unparsed', valid: [], demoted: [], body: null };
  // La soppressione NON riscrive il corpo (chiude e basta), quindi non ha bisogno della
  // garanzia sotto: un over-split lascia comunque ogni riga `Suggested action` dentro
  // QUALCHE frammento, che risulta valido — non può fabbricare un falso `no-valid-item`.
  if (!valid.length) return { action: 'suppress', reason: 'no-valid-item', valid, demoted, body: null };
  if (!demoted.length) return { action: 'keep', reason: 'all-items-falsifiable', valid, demoted, body: null };
  // Riscrivere il corpo è l'unica azione distruttiva del gate, e `splitFollowupItems()`
  // spezza su `^### \d+\.` ANCHE dentro un blocco citato: un item che riporta verbatim
  // una riga `### 2.` (il conio cita body di PR e review, che usano quel formato) produce
  // un frammento spurio, e ricomporre butterebbe via la coda dell'item vero. Finché il
  // gate leggeva soltanto era innocuo; adesso scrive. Quindi la riscrittura parte solo se
  // ricomporre TUTTI gli item riproduce il corpo originale: se il round-trip non torna,
  // non ho capito il corpo e non lo tocco.
  if (!isLosslessSplit(issue?.body || '')) {
    return { action: 'skip', reason: 'unsafe-rewrite', valid, demoted, body: null };
  }
  return { action: 'demote', reason: 'some-items-not-falsifiable', valid, demoted, body: rebuildBody(head, valid) };
}

/**
 * Il corpo si ricompone identico dai suoi item? Confronto con gli spazi normalizzati (la
 * ricomposizione uniforma le righe vuote fra un item e l'altro): la rinumerazione e ogni
 * frammento spurio restano visibili, perché sono cifre e testo, non spaziatura. Puro.
 *
 * @param {string} body @returns {boolean}
 */
export function isLosslessSplit(body) {
  const src = String(body || '');
  const items = splitFollowupItems(src);
  if (!items.length) return false;
  const flat = (s) => s.replace(/\s+/g, ' ').trim();
  return flat(rebuildBody(src.split(/^### \d+\./m)[0], items)) === flat(src);
}

/** Ricompone il corpo con i soli item validi, rinumerati (formato uniforme per il fixer). */
export function rebuildBody(head, valid) {
  return `${head.replace(/\s+$/, '')}\n\n${valid.map((it, i) => `### ${i + 1}.${it.replace(/\s+$/, '')}`).join('\n\n')}\n`;
}

/** Titolo con il conteggio item riallineato (`N item deferred` → `M item deferred`). */
export function retitle(title, n) {
  return String(title || '').replace(/\b\d+\s+(item|verifiche)\b/i, `${n} $1`);
}

/**
 * Il blocco che finisce nel commento della PR: il testo INTEGRALE di ogni item demoto,
 * non il suo titolo. Nel ramo `demote` il corpo della issue viene riscritto senza quegli
 * item, quindi questo blocco è l'unica copia che resta di `Source`, `Stato dichiarato
 * nella PR`, `Original text` e `Suggested action`. È la mitigazione su cui poggia
 * l'intera scelta di demozione: se qui sopravvivesse solo la prima riga, il prezzo
 * dichiarato («resta leggibile sulla PR») sarebbe falso, in modo irreversibile e ~11
 * volte al giorno. Puro, così il test lo esercita senza rete.
 *
 * @param {string[]} demoted @returns {string}
 */
export function demotedBlock(demoted) {
  return (demoted || []).map((it) => `### ${itemHeadline(it)}\n${String(it).trim()}`).join('\n\n');
}

/** Prima riga di un item, per l'elenco nel commento della PR. */
export function itemHeadline(itemText) {
  return String(itemText || '').split('\n')[0].trim().replace(/^[-–—\s]+/, '') || '(senza titolo)';
}

// Ritorna `null` quando la chiamata fallisce (con allowFail), non la stringa vuota: il
// chiamante DEVE poter distinguere «riuscito, output vuoto» da «non riuscito», perche' le
// scritture qui sono in sequenza e la seconda non ha senso se la prima non e' passata.
function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 1 << 26 });
  } catch (e) {
    if (allowFail) {
      console.log(`gh ${args.slice(0, 3).join(' ')} → fallito: ${e?.message?.split('\n')[0]}`);
      return null;
    }
    throw e;
  }
}

function writeBodyFile(text) {
  const p = path.join(os.tmpdir(), `mint-gate-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(p, text);
  return p;
}

function main() {
  const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];
  const prs = String(process.env.BATCH_PRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  if (!prs.length) {
    console.log('gate-minted-followups: batch vuoto, niente da controllare.');
    return;
  }
  // UNA lista sola per tutto il batch, e SENZA `--search`. La ricerca GitHub passa da un
  // indice con latenza propria: una issue creata dallo step precedente pochi secondi fa
  // puo' non esserci ancora, e il gate non troverebbe nulla proprio nel caso per cui
  // esiste. La `list` REST e' immediatamente consistente. Niente `body` qui: con ~170
  // issue follow-up il dump e' emoji-heavy e grosso — i corpi si leggono uno per uno,
  // solo per le poche issue che il filtro sul titolo seleziona davvero.
  const openRaw = gh(['issue', 'list', ...repoArgs, '--label', 'follow-up', '--state', 'open',
    '--limit', '200', '--json', 'number,title,createdAt'], { allowFail: true });
  let open = [];
  try { open = JSON.parse(openRaw || '[]') || []; } catch { open = []; }
  // Al tetto la lista e' potenzialmente troncata: «issue non trovata» diventa ambiguo fra
  // «il conio non ne ha creata nessuna» e «c'e' ma non l'ho vista». Dirlo, invece di
  // lasciare che il no-op sembri una conferma.
  if (open.length >= 200) console.log(`⚠️ lista al tetto (${open.length}): una issue coniata potrebbe non comparire — se un no-op sorprende, alzare il limite.`);
  const report = [];
  for (const pr of prs) {
    try {
      const found = open.filter((i) => String(i.title || '').startsWith(`follow-up(#${pr})`));
      if (!found.length) { console.log(`PR #${pr}: nessuna issue coniata → niente da fare.`); continue; }
      const issues = [];
      for (const f of found) {
        const one = gh(['issue', 'view', String(f.number), ...repoArgs, '--json', 'number,title,body,createdAt'], { allowFail: true });
        try { issues.push(JSON.parse(one)); } catch { /* proceed-safe: issue illeggibile → intatta */ }
      }
      for (const iss of issues) {
        const d = decideMintGate(iss);
        console.log(`#${iss.number} (PR #${pr}) → ${d.action} (${d.reason}; validi ${d.valid.length}, demoti ${d.demoted.length})`);
        if (d.action === 'skip' || d.action === 'keep') continue;
        const list = d.demoted.map((it) => `- «${itemHeadline(it)}»`).join('\n');
        // Il TESTO INTEGRALE, non il titolo. Nel ramo `demote` il corpo della issue viene
        // riscritto senza gli item demoti: se qui sopravvivesse solo la prima riga,
        // `Source`, `Stato dichiarato nella PR`, `Original text` e `Suggested action`
        // sarebbero cancellati e non riprodotti da nessuna parte — e la mitigazione su cui
        // poggia l'intera scelta di demozione («resta leggibile sulla PR») sarebbe falsa,
        // in modo irreversibile e ~11 volte al giorno. Nel ramo `suppress` il corpo resta
        // perché la issue è solo chiusa, ma il blocco integrale non fa danno neanche lì.
        const verbatim = demotedBlock(d.demoted);
        const why = `${MINT_GATE_MARKER}\n🚧 **Gate deterministico sul conio** (zero-Claude): ${d.demoted.length} item non porta${d.demoted.length === 1 ? '' : 'no'} una condizione di accettazione falsificabile — nessun token-codice distintivo in una riga \`Suggested action\`, quindi nessuna evidenza potrà mai provarl${d.demoted.length === 1 ? 'o' : 'i'} affrontat${d.demoted.length === 1 ? 'o' : 'i'}. Oracolo: \`hasFalsifiableAcceptance()\` in \`scripts/ci/followup-resolution-match.mjs\`, lo STESSO che chiude l'item.\n\n${list}`;
        if (DRY_RUN) { console.log(why); continue; }
        // ORDINE, non decorazione: prima si CONSERVA il testo sulla PR, poi si tocca la
        // issue. Il verso opposto — riscrivi il corpo, poi prova a commentare — perde gli
        // item per sempre se la seconda chiamata fallisce, ed e' proprio la finestra in
        // cui `gh` fallisce piu' spesso (rate limit dopo N scritture in un batch).
        const posted = gh(['pr', 'comment', String(pr), ...repoArgs, '--body',
          `${MINT_GATE_MARKER}\n## Item demoti dal gate sul conio\n\nNon tracciati come item (nessuna condizione di accettazione falsificabile), ma **conservati qui integralmente**, come i \`Live-verification\`. ${d.action === 'suppress' ? `Issue #${iss.number} chiusa in ingresso: non restava nessun item valido.` : `Issue #${iss.number} resta aperta con ${d.valid.length} item valid${d.valid.length === 1 ? 'o' : 'i'}; questi sono stati tolti dal suo corpo e vivono solo qui.`}\n\n${verbatim}`],
          { allowFail: true });
        if (d.action === 'demote' && posted === null) {
          console.log(`⚠️ #${iss.number}: commento sulla PR #${pr} non riuscito → NON riscrivo il corpo. Gli item demoti restano dove sono; il prossimo giro riprova.`);
          report.push(`- ⏭️ #${iss.number} demozione rinviata (commento sulla PR non riuscito) — PR #${pr}`);
          continue;
        }
        if (d.action === 'suppress') {
          gh(['issue', 'comment', String(iss.number), ...repoArgs, '--body',
            `${why}\n\nNessun item valido resta: questa issue non sarebbe mai potuta uscire dalla coda (\`aggregateCloseGate()\` la blocca per costruzione). Chiusa in ingresso; il testo resta qui e nel commento di summary della PR #${pr}. Se un item era lavoro vero, riaprilo come issue autonoma con una riga \`Suggested action\` che citi il simbolo **nella sua forma di codice**: un identificatore nudo (\`nomeFunzione\`) e un path nudo (\`scripts/ci/foo.mjs\`) non contano, perché compaiono nel file citato a prescindere dal fix — servono \`nomeFunzione()\`, \`oggetto.campo\`, \`COSTANTE >= 1\` o simili (\`isDistinctiveToken()\`, classe #1647).`],
            { allowFail: true });
          gh(['issue', 'close', String(iss.number), ...repoArgs, '--reason', 'not planned'], { allowFail: true });
          report.push(`- 🚫 #${iss.number} soppressa in ingresso (${d.demoted.length} item senza condizione di accettazione) — PR #${pr}`);
        } else {
          const bf = writeBodyFile(d.body);
          gh(['issue', 'edit', String(iss.number), ...repoArgs, '--body-file', bf,
            '--title', retitle(iss.title, d.valid.length)], { allowFail: true });
          fs.rmSync(bf, { force: true });
          gh(['issue', 'comment', String(iss.number), ...repoArgs, '--body',
            `${why}\n\nRimoss${d.demoted.length === 1 ? 'o' : 'i'} dal corpo; ${d.valid.length} item valid${d.valid.length === 1 ? 'o' : 'i'} rest${d.valid.length === 1 ? 'a' : 'ano'}.`],
            { allowFail: true });
          report.push(`- ✂️ #${iss.number} ${d.demoted.length} item demoti, ${d.valid.length} restano — PR #${pr}`);
        }
      }
    } catch (e) {
      // Proceed-safe: un guasto su una PR non deve toccare le altre né far cadere il triage.
      console.log(`PR #${pr}: gate saltato (${e?.message?.split('\n')[0]}) — issue lasciata intatta.`);
    }
  }
  const summary = `Gate sul conio: ${report.length} issue toccate${DRY_RUN ? ' (dry-run)' : ''}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${summary}\n${report.join('\n')}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
