#!/usr/bin/env node
/**
 * needs-human-prepass.mjs — la metà deterministica dello sweep `needs-human`.
 *
 * ## Il difetto, misurato
 *
 * `needs-human` era assorbente, e `needs-human-sweep.yml` è stato costruito per
 * drenarlo. Ma il suo drenaggio è UN run Claude alla settimana con un cap di 15
 * azioni, e il 2026-08-24 le issue `needs-human` sul sito erano **59** — quattro
 * settimane di coda nel caso migliore, mentre lo stadio VERDICT-EXIT (#6323) ne
 * aggiunge di nuove a ogni tick del drainer: 15 escalation nei primi 15 minuti
 * dal suo merge. Un'uscita che riceve più di quanto emette non è un'uscita.
 *
 * La cosa che rende il cap sprecato è che la maggior parte di quelle issue **non
 * contiene una decisione**. Sulle 59 misurate, 7 erano decisioni vere (registrate
 * in `VISION.md` § «Decisioni RICHIESTE»); le altre erano guasti aperti da un
 * monitor — `Crawler Failure:`, `CI Failure:`, `Validation Failure (dist)`,
 * `[crawler-health]`, `App Error:`, `PostHog Exception:` — e follow-up tecniche
 * con item deferred. Su nessuna di queste serve il giudizio di un modello per
 * dire «questa non è una domanda per il proprietario»: il titolo lo dice, e il
 * titolo lo scrive un nostro script.
 *
 * Questo pre-pass le rimette in coda a costo zero, e lascia al run Claude
 * esattamente le issue su cui un giudizio serve davvero.
 *
 * ## Perché una ALLOWLIST e non una denylist
 *
 * La direzione dell'errore non è simmetrica. Ri-accodare per sbaglio una
 * decisione del proprietario significa far implementare al fixer una scelta che
 * non gli spetta — espansione di scope, denaro, consenso — ed è esattamente ciò
 * che la lista «Sempre umano» di `VISION.md` esiste per impedire. Lasciare per
 * sbaglio una tecnica al run Claude costa invece un'azione del suo cap.
 *
 * Quindi si riconoscono POSITIVAMENTE le famiglie generate da noi, e tutto il
 * resto resta dov'è. Una famiglia nuova di monitor non viene drenata da questo
 * script finché qualcuno non la aggiunge qui — che è il modo giusto di
 * sbagliare, perché il run Claude la prende comunque.
 *
 * ## Il verdetto batte il riconoscimento di famiglia (fix #5608)
 *
 * Un'issue di famiglia monitor può arrivare in `needs-human` già passata per lo
 * stadio VERDICT-EXIT di `followup-drainer.mjs`, che la escala lì apposta come
 * uscita TERMINALE per un verdetto `NON_RETRYABLE` (es. `no-root-cause`) — con
 * lo sweep settimanale di `needs-human-sweep.yml` come «sola porta di rientro»
 * dichiarata in `verdictExitDecision`. Prima di questa fix, questo pre-pass
 * GIORNALIERO ignorava il verdetto per ogni titolo di famiglia riconosciuto e
 * la re-accodava comunque ad `agent:fix-queued` — riproducendo lo stesso
 * verdetto allo stesso costo prima ancora che lo sweep settimanale la vedesse.
 * Misurato su #5608 (`PostHog Exception:`): no-root-cause confermato tre volte
 * in tre run separate, ognuna preceduta da un re-accodo di questo script nel
 * giorno precedente. Ora un verdetto `NON_RETRYABLE` vince sul riconoscimento
 * di famiglia e la issue resta `keep` per il giudizio dello sweep.
 *
 * Dal 2026-09-04 (escalation #7307) l'insieme che vince è
 * `PREPASS_VERDICT_BEATS_FAMILY`, cioè `NON_RETRYABLE` più `max-turns`. Il
 * criterio non è «il verdetto è definitivo» ma «questo script può cambiare
 * qualcosa prima di rimetterla in coda?»: non sa scrivere una scheda, quindi un
 * ri-accodo sul solo titolo rifà la stessa run allo stesso costo. Lo sweep
 * Claude una scheda la scrive, e resta la porta di rientro.
 */
import { execFileSync } from 'node:child_process';
import { FIX_OUTCOME_RE } from './close-recovered-failure-issues.mjs';
import { PREPASS_VERDICT_BEATS_FAMILY, AGGREGATE_ITEMS_RE } from './followup-drainer.mjs';

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const DRY = process.argv.includes('--dry-run');
// Cap volutamente BASSO, e tarato sulla portata a valle e non sulla dimensione
// della coda: il sito consegna ~15 PR al giorno (108 `pr-created` in 7 giorni
// misurati il 2026-08-24), quindi immettere 25 issue al giorno riempirebbe la
// coda piu' in fretta di quanto la si svuota — e sopra ~5 PR aperte i merge
// rallentano da soli. A 10/giorno le 59 parcheggiate rientrano in circa una
// settimana senza che nessun altro stadio se ne accorga.
const MAX_PER_RUN = Number(process.env.PREPASS_MAX_PER_RUN || 10);

/**
 * Le famiglie di issue APERTE DA UN MONITOR, riconosciute sul titolo.
 *
 * Ognuna è un titolo che scrive un nostro script, non una persona: il prefisso è
 * parte del contratto di dedup di chi le apre (vedi il vincolo dei 60 caratteri
 * sul titolo canonico), quindi è stabile e non è una euristica sul linguaggio.
 */
export const MONITOR_TITLE_PATTERNS = [
  /^Crawler Failure:/i,
  /^CI Failure:/i,
  /^Workflow Failure:/i,
  /^Validation Failure/i,
  /^\[crawler-health\]/i,
  /^\[data-quality\]/i,
  /^App Error:/i,
  /^PostHog Exception:/i,
  /^CWV (field )?[Rr]egression/i,
  /^follow-up\(#\d+\):/i,
];

/**
 * Un container: più cause o più target → si scorpora invece di ri-accodarsi.
 *
 * È `AGGREGATE_ITEMS_RE` di `followup-drainer.mjs`, importata e non ricopiata.
 * Qui c'era una seconda definizione, e le due erano DIVERSE: questa diceva
 * `\s+item\s+`, quella dice `\s+items?\s+`. I titoli li scrive un LLM e usa
 * entrambe le forme (nella coda di oggi convivono «3 item deferred» e «3 items
 * deferred»), quindi la copia locale mancava gli aggregati al plurale e li
 * mandava al `requeue` intero — «il modo documentato di rifare max-turns»,
 * secondo il commento del ramo qui sotto. Una regex duplicata in due file è
 * proprio il costrutto che AGENTS.md #6 vieta, e questo è il drift che produce.
 */
export { AGGREGATE_ITEMS_RE as AGGREGATE_TITLE_RE } from './followup-drainer.mjs';

/**
 * Verdetti che il 2026-08-24 hanno smesso di essere blocchi di capacità.
 *
 * `blocked-secrets`: il proprietario ha autorizzato in modo permanente l'uso dei
 * secret (registro in `VISION.md`), e `issue-fix.yml` carica Remote Config prima
 * del run. Un verdetto emesso prima di quella data descrive una configurazione
 * che non esiste più, quindi la issue è lavoro normale.
 */
export const STALE_BLOCK_VERDICTS = new Set(['blocked-secrets']);


/** Ultimo verdetto da una lista di commenti (forma REST o GraphQL). Pura. */
export function latestVerdict(comments) {
  let latest = null;
  let at = -Infinity;
  for (const c of comments || []) {
    const m = FIX_OUTCOME_RE.exec(String(c?.body || ''));
    if (!m) continue;
    const t = Date.parse(c?.created_at ?? c?.createdAt);
    if (!Number.isNaN(t) && t >= at) { at = t; latest = m[1].toLowerCase(); }
  }
  return latest;
}

/**
 * La decisione, dal solo titolo + labels + ultimo verdetto. Pura → testabile.
 *
 * `keep` è il default e non un ramo di errore: significa «non so dirlo senza
 * giudizio», e il run Claude dello sweep è il posto dove quel giudizio si dà.
 *
 * @param {{title?: string, labels?: string[], verdict?: string|null}} iss
 * @returns {{action: 'requeue'|'decompose'|'keep', reason: string}}
 */
export function prepassDecision({ title = '', labels = [], verdict = null } = {}) {
  // Un tracker permanente è aperto per scelta: non si accoda e non si scorpora.
  if (labels.includes('agent:no-age-out')) return { action: 'keep', reason: 'tracker permanente' };
  // Sotto lavorazione attiva di una sessione locale (claim mutex, #6427): l'unico
  // caso dove `needs-human` + un'altra label può davvero significare «in volo».
  // `agent:fix`/`agent:fix-queued`/`agent:decompose`/`agent:decompose-queued`
  // NON qualificano: la query a monte (`main()`) filtra già su `needs-human`,
  // quindi ogni issue che arriva qui ce l'ha SEMPRE — e nessuno di quei 4 stadi
  // aggiunge `needs-human` restando `agent:fix*`/`agent:decompose*` mentre è
  // davvero in coda: è lo stato morto lasciato dall'escalation VERDICT-EXIT
  // (prima di questa fix non rimuoveva quelle label), mai un'issue in lavoro.
  for (const l of ['agent:in-progress']) {
    if (labels.includes(l)) return { action: 'keep', reason: `già in lavorazione (${l})` };
  }

  if (verdict && STALE_BLOCK_VERDICTS.has(verdict)) {
    return { action: 'requeue', reason: `verdetto \`${verdict}\` superato dalla decisione del 2026-08-24 sui secret` };
  }

  const monitor = MONITOR_TITLE_PATTERNS.find((re) => re.test(title));
  if (!monitor) return { action: 'keep', reason: 'famiglia non riconosciuta: la valuta il run Claude' };

  // Un container con N item deferred ha più target: lo scorporo produce sub-issue
  // atomiche, dove la resa del fixer è più alta. Ri-accodarlo intero è il modo
  // documentato di rifare `max-turns`.
  if (AGGREGATE_ITEMS_RE.test(title)) {
    return { action: 'decompose', reason: 'container multi-item generato da un monitor' };
  }
  // Il verdetto vince sul riconoscimento di famiglia — ma SOLO sul `requeue`, ed
  // è per questo che questo blocco sta DOPO lo scorporo e non prima.
  //
  // Perché la guardia esiste (#5608): una issue di famiglia monitor può arrivare
  // qui via VERDICT-EXIT (`followup-drainer.mjs`) proprio perché il fixer ha già
  // raggiunto un verdetto `NON_RETRYABLE`; quello stadio la manda in
  // `needs-human` come uscita TERMINALE, con lo sweep settimanale come «sola
  // porta di rientro» (commento in `verdictExitDecision`). Ri-accodarla a
  // `agent:fix-queued` prima che lo sweep la veda riproduce lo stesso verdetto
  // allo stesso costo — il loop misurato su #5608 (`no-root-cause` → escalate →
  // re-accodata dal pre-pass del giorno dopo → stesso `no-root-cause`, tre volte).
  //
  // Dal 2026-09-04 l'insieme include anche `max-turns` (escalation #7307): il
  // drainer lo parcheggia `fu-parked` + `needs-human` quando la issue non è
  // eleggibile alla decomposizione, e questo pre-pass la ri-accodava il giorno
  // dopo sul solo titolo di famiglia — `Crawler Failure: Run zurich` (#7242) e
  // `Run volg` (#7179), rimesse in coda alle 06:49 con NULLA cambiato dal
  // verdetto e ripromosse ad `agent:fix` alle 10:13 per rifare gli stessi turni.
  //
  // PERCHÉ LA POSIZIONE CONTA (🔴 della review su nanako#778, difetto introdotto
  // da #7313 e che qui era già latente sui verdetti `NON_RETRYABLE`). Il criterio
  // della costante è «questo stadio sa cambiare qualcosa prima di rimettere in
  // coda?». Lo scorporo qui sopra **sa**: cambia l'input del fixer esattamente
  // come la scheda dello sweep, ed è il ramo che il drainer stesso sceglie su
  // `max-turns` (DECOMPOSE-ROUTE). Con la guardia messa prima, un container
  // aggregato di famiglia monitor con un verdetto catturato perdeva quell'uscita
  // e diventava `keep` — cioè il ramo `decompose` veniva spento proprio nel caso
  // in cui serve. Qui sotto la guardia intercetta il solo ri-accodo intero, che
  // è l'unica azione che non cambia niente.
  if (verdict && PREPASS_VERDICT_BEATS_FAMILY.has(verdict)) {
    return { action: 'keep', reason: `verdetto \`${verdict}\` non ri-accodabile a costo zero: resta per il giudizio dello sweep settimanale` };
  }
  return { action: 'requeue', reason: `famiglia di monitor riconosciuta (${monitor})` };
}

function gh(args, { json = true } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return json ? JSON.parse(out) : out;
}

function main() {
  if (!REPO) { console.log('needs-human-prepass: nessun repo risolvibile → niente da fare.'); return; }
  let issues = [];
  try {
    issues = gh(['issue', 'list', '--repo', REPO, '--state', 'open', '--label', 'needs-human',
      '--json', 'number,title,labels,updatedAt', '--limit', '300']);
  } catch (e) {
    console.log(`::warning::needs-human-prepass: elenco non leggibile (${String(e).slice(0, 100)}) → nessuna azione.`);
    return;
  }
  console.log(`needs-human-prepass — repo ${REPO}, ${issues.length} issue \`needs-human\`${DRY ? ' [DRY-RUN]' : ''}`);

  // Le più stantie prima: sono quelle che aspettano da più tempo, e il cap non
  // deve tagliarle sempre. `gh issue list` ordina dalla più recente.
  const ordered = [...issues].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));

  const counts = { requeue: 0, decompose: 0, keep: 0 };
  let acted = 0;
  for (const iss of ordered) {
    const labels = (iss.labels || []).map((l) => l.name);
    // Il verdetto si legge sempre (anche per un titolo di famiglia monitor
    // riconosciuto): un verdetto NON_RETRYABLE vince sul riconoscimento di
    // famiglia (vedi `prepassDecision`), quindi non può più essere saltato solo
    // perché il titolo basterebbe a decidere `requeue` da solo.
    let verdict = null;
    try {
      const cs = gh(['api', `repos/${REPO}/issues/${iss.number}/comments?per_page=100`, '--paginate']);
      verdict = latestVerdict(Array.isArray(cs) ? cs : []);
    } catch { verdict = null; }
    const d = prepassDecision({ title: iss.title, labels, verdict });
    counts[d.action]++;
    if (d.action === 'keep') continue;

    if (acted >= MAX_PER_RUN) {
      console.log(`needs-human-prepass: cap ${MAX_PER_RUN}/run raggiunto → il resto al prossimo giro (no silent cap).`);
      break;
    }
    acted++;
    const add = d.action === 'requeue' ? 'agent:fix-queued' : 'agent:decompose-queued';
    if (DRY) { console.log(`[dry] #${iss.number} → ${add} (${d.reason}) — "${iss.title.slice(0, 60)}"`); continue; }
    const note = `🔁 **Pre-pass deterministico dello sweep (zero-Claude)**: ${d.reason}. Questa issue non contiene una decisione del proprietario — le decisioni vere stanno in \`VISION.md\` § «Decisioni RICHIESTE» — quindi torna nel ciclo autonomo invece di occupare un'azione del cap del run Claude.`;
    try {
      gh(['issue', 'comment', String(iss.number), '--repo', REPO, '--body', note], { json: false });
      gh(['issue', 'edit', String(iss.number), '--repo', REPO,
        '--add-label', add, '--remove-label', 'needs-human', '--remove-label', 'fu-parked'], { json: false });
      console.log(`PREPASS #${iss.number} → ${add} (${d.reason})`);
    } catch (e) {
      console.log(`::warning::needs-human-prepass: #${iss.number} non instradata (${String(e).slice(0, 100)}).`);
    }
  }
  console.log(`needs-human-prepass: requeue=${counts.requeue} decompose=${counts.decompose} keep=${counts.keep} (azioni eseguite: ${acted}).`);
}

if (process.argv[1] && process.argv[1].endsWith('needs-human-prepass.mjs')) main();
