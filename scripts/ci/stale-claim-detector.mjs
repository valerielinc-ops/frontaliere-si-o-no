/**
 * stale-claim-detector.mjs — rilascia i lock `agent:in-progress` rimasti appesi
 * su issue aperte (zero-Claude, deterministico).
 *
 * ## Il buco che chiude
 *
 * `agent:in-progress` **non è uno stato, è un lock di mutua esclusione**:
 * `claim-issue-in-flight.mjs` lo mette come primo pre-flight di `issue-fix.yml`,
 * e se lo trova già presente il fixer salta tutto, quota zero. È il meccanismo
 * che ha chiuso la collisione #4788/#4793, dove una sessione interattiva e il
 * fixer autonomo hanno lavorato la stessa issue producendo due PR concorrenti.
 *
 * Il lock ha un rilascio simmetrico (`if: always()` su ogni percorso terminale
 * di `issue-fix.yml`), ma quel rilascio vive DENTRO il run: se il run muore in
 * modo non grazioso — runner ucciso, cancellazione infrastrutturale — o se una
 * sessione interattiva muore dopo aver reclamato, la label resta. E su una issue
 * **aperta** un lock appeso la esclude dal fixer **per sempre, in silenzio**:
 * ogni dispatch futuro vede il claim, salta, ed esce 0. Nessun allarme, nessun
 * digest, nessuna scadenza. È successo sulla #4248 (`priority:high`), appesa da
 * una sessione precedente.
 *
 * È la stessa forma della draft parcheggiata di `parked-pr-detector.mjs` — un
 * segnale silenzioso che dura per sempre — su una superficie diversa e con una
 * causa diversa.
 *
 * ## La trappola, che è il motivo per cui non basta l'età
 *
 * **Finché una PR è in volo il claim è CORRETTO e va lasciato.** Toglierlo
 * mentre il fixer sta lavorando fa ripartire un secondo fixer in parallelo:
 * ricrea esattamente la #4788/#4793 che il lock esiste per impedire, e la
 * ricrea *causandola noi*. Un detector che guardasse solo l'età sarebbe peggio
 * del problema che risolve.
 *
 * Quindi la condizione è doppia: claim presente **E** nessuna PR aperta che lo
 * giustifichi. E l'estrazione dei riferimenti è deliberatamente GENEROSA
 * (branch `fix/issue-N`, `(#N)` nel titolo, `Closes/Fixes/Resolves #N` nel
 * body): sovra-riconoscere una PR significa NON rilasciare, cioè sbagliare
 * verso il lato sicuro. I due errori non costano uguale — un lock lasciato un
 * giro in più costa una latenza, un lock tolto troppo presto costa due PR in
 * conflitto e la quota per produrle.
 *
 * ## La soglia
 *
 * Default 12h = **2× il `timeout-minutes: 360` di `issue-fix.yml`**. Un run del
 * fixer non può, per costruzione, durare più di 6h: oltre il doppio di quel
 * tetto, senza una PR aperta, il claim non appartiene più a niente di vivo.
 * L'età si legge da `updatedAt` della issue, che il claim stesso ha bumpato
 * applicando la label — quindi `updatedAt` è sempre ≥ l'istante del claim, e
 * una issue con attività recente (una sessione interattiva che ci commenta) non
 * viene mai selezionata.
 *
 * ## Cosa fa, e cosa deliberatamente non fa
 *
 * RILASCIA il lock (rimuove la label) e commenta perché. Non ri-accoda: un
 * `agent:fix` richiede il PAT e riaccenderebbe subito un run, mentre «questa
 * issue va rilavorata» è una decisione separata da «questo lock non appartiene
 * a nessuno». Rilasciare è ciò che ripristina l'idoneità — è il lock, non la
 * coda, ad essere rotto.
 *
 * Nota la differenza di postura rispetto a `parked-pr-detector.mjs`, che
 * etichetta e NON agisce: là l'azione giusta (chiudere una draft) distruggerebbe
 * lavoro se sbagliata, qui l'azione giusta (togliere un lock morto) è
 * reversibile e la non-azione è il danno permanente.
 *
 * Uso:  node scripts/ci/stale-claim-detector.mjs [--dry-run]
 * Env:  GH_TOKEN, GH_REPO/GITHUB_REPOSITORY, STALE_CLAIM_HOURS (default 12).
 */
import { execFileSync } from 'node:child_process';
import { hasCommentMarker } from './lib/prComments.mjs';

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const CLAIM_LABEL = 'agent:in-progress';
const MARKER = '<!-- STALE-CLAIM-RELEASED -->';

/** 2× il timeout-minutes di issue-fix.yml (360). Vedi l'intestazione. */
export const DEFAULT_STALE_CLAIM_HOURS = 12;

function gh(args, { json = true, allowFail = false } = {}) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return json ? JSON.parse(out) : out;
  } catch (e) {
    if (allowFail) return json ? null : '';
    throw e;
  }
}

/**
 * I numeri di issue che una PR aperta sta già lavorando — cioè i claim che
 * NON vanno toccati.
 *
 * Tre canali, tutti quelli con cui il ciclo lega una PR alla sua issue:
 *   - `headRefName` `fix/issue-N`, il nome DETERMINISTICO che `issue-fix.yml`
 *     dà al branch (ed è il canale più affidabile: esiste anche prima che il
 *     body sia scritto bene);
 *   - `(#N)` nel titolo, la convenzione delle PR del fixer;
 *   - `Closes/Fixes/Resolves #N` nel body.
 *
 * Puro → testabile, e generoso di proposito: ogni match in più è una PR che
 * consideriamo viva, quindi un claim che NON rilasciamo.
 */
export function referencedIssueNumbers(prs) {
  const out = new Set();
  if (!Array.isArray(prs)) return out;
  for (const pr of prs) {
    if (!pr) continue;
    const branch = String(pr.headRefName || '');
    const mBranch = /^fix\/issue-(\d+)$/.exec(branch);
    if (mBranch) out.add(Number(mBranch[1]));
    for (const m of String(pr.title || '').matchAll(/\(#(\d+)\)/g)) out.add(Number(m[1]));
    // Italian forms (issue #567 twin sweep, see followup-resolution-match.mjs
    // CLOSE_KW_LIST): `chiud[eo]`/`risolv[eo]`/`super[ae]` plus the same
    // bridge words ("anche", "la"/"le", "issue") between verb and `#N`. This
    // detector is deliberately generous — an extra match means a claim is
    // NOT released — so under-recognizing an Italian "Chiude anche #N" body
    // is the unsafe direction: it would let a live claim look orphaned.
    for (const m of String(pr.body || '').matchAll(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|chiud[eo]|risolv[eo]|super[ae])\b[:\s]+(?:anche\s+)?(?:l[ae]\s+)?(?:issue\s+)?#(\d+)/gi,
    )) {
      out.add(Number(m[1]));
    }
  }
  return out;
}

/**
 * Quali issue portano un lock che non appartiene più a niente.
 *
 * `nowMs` è un parametro e non `Date.now()`: una soglia temporale testata
 * contro l'orologio reale è un test che cambia risposta a seconda di quando
 * gira. `updatedAt` illeggibile → NON selezionata: in dubbio si tace, perché il
 * costo di un falso positivo qui è un secondo fixer in parallelo.
 */
export function selectStaleClaims(issues, referenced, nowMs, maxAgeHours = DEFAULT_STALE_CLAIM_HOURS) {
  if (!Array.isArray(issues)) return [];
  const live = referenced instanceof Set ? referenced : new Set(referenced || []);
  const cutoff = nowMs - maxAgeHours * 3600 * 1000;
  return issues.filter((iss) => {
    if (!iss || !Number.isInteger(iss.number)) return false;
    if (!(iss.labels || []).some((l) => l && l.name === CLAIM_LABEL)) return false;
    if (live.has(iss.number)) return false;
    const updated = Date.parse(iss.updatedAt || '');
    if (!Number.isFinite(updated)) return false;
    return updated < cutoff;
  });
}

function main() {
  if (!REPO) { console.error('GH_REPO/GITHUB_REPOSITORY mancante'); process.exit(1); }
  const hours = Number(process.env.STALE_CLAIM_HOURS) || DEFAULT_STALE_CLAIM_HOURS;
  console.log(`stale-claim-detector${DRY ? ' [DRY-RUN]' : ''} repo=${REPO} soglia=${hours}h`);

  let issues, prs;
  try {
    issues = gh(['issue', 'list', '--repo', REPO, '--state', 'open', '--label', CLAIM_LABEL,
      '--limit', '100', '--json', 'number,title,updatedAt,labels']);
    prs = gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '100',
      '--json', 'number,title,body,headRefName']);
  } catch (e) {
    // Non fallire il job: questo è un segnale, non un gate. E soprattutto, un
    // elenco di PR incompleto porterebbe a rilasciare un claim VIVO — quindi
    // senza entrambe le liste non si decide niente.
    console.error(`gh list fallito: ${String(e).slice(0, 160)} — skip.`);
    process.exit(0);
  }

  const referenced = referencedIssueNumbers(prs || []);
  const stale = selectStaleClaims(issues || [], referenced, Date.now(), hours);

  console.log(`issue con ${CLAIM_LABEL}: ${(issues || []).length} — PR aperte che ne giustificano una: ${referenced.size}`);
  if (!stale.length) { console.log('Nessun claim stale.'); return; }
  console.log(`Claim stale: ${stale.length}`);

  for (const iss of stale) {
    console.log(`  #${iss.number} fermo dal ${iss.updatedAt} — ${String(iss.title).slice(0, 80)}`);

    // ORDINE LOAD-BEARING, ed è l'INVERSO di parked-pr-detector.mjs perché la
    // selezione è invertita: là si seleziona chi NON ha la label, qui chi ce
    // l'ha. Commentando per primo, se la rimozione fallisce la issue viene
    // ri-selezionata al run dopo, il marker impedisce il doppione e la
    // rimozione viene riprovata. Rimuovendo per primo, un commento fallito non
    // sarebbe mai più riprovato — il lock risulterebbe sparito senza che
    // nessuno sappia perché, che è il modo peggiore di aggiustare un problema
    // di segnali silenziosi.
    const body = `🔓 **Lock rilasciato** (auto, zero-Claude): questa issue portava \`${CLAIM_LABEL}\` ` +
      `da più di ${hours}h **senza nessuna PR aperta che lo giustificasse**.\n\n` +
      `\`${CLAIM_LABEL}\` non è uno stato, è un **lock di mutua esclusione**: finché è ` +
      'presente, ogni run di `issue-fix` vede il claim ed esce senza fare niente. Un run morto ' +
      'in modo non grazioso — o una sessione interattiva finita male — lo lascia appeso, e da ' +
      'quel momento la issue è esclusa dal fixer **per sempre e in silenzio**.\n\n' +
      `La soglia è ${hours}h perché \`issue-fix.yml\` ha \`timeout-minutes: 360\`: oltre il ` +
      'doppio del tetto di un run, senza PR in volo, il claim non appartiene più a niente di ' +
      'vivo. Se invece stai lavorando questa issue **ora**, ri-applica la label: il detector ' +
      'guarda le PR aperte, quindi appena ne apri una il claim viene rispettato.\n\n' +
      'La issue **non** è stata ri-accodata: rilasciare il lock ripristina l\'idoneità, ma ' +
      'decidere che vada rilavorata è un\'altra cosa. Per rimetterla in coda serve `agent:fix` ' +
      '(via PAT).\n\n' +
      '_Segnale deterministico da `stale-claim-detector.mjs`. Il commento non si ripete._';

    if (hasCommentMarker(gh, REPO, iss.number, MARKER)) {
      console.log(`  #${iss.number}: marker già presente — no comment (rilascio comunque riprovato).`);
    } else if (DRY) {
      console.log(`  [dry] comment ${MARKER} #${iss.number}`);
    } else {
      gh(['issue', 'comment', String(iss.number), '--repo', REPO, '--body', `${MARKER}\n${body}`],
        { json: false, allowFail: true });
    }

    if (DRY) { console.log(`  [dry] -label ${CLAIM_LABEL} #${iss.number}`); }
    else {
      gh(['issue', 'edit', String(iss.number), '--repo', REPO, '--remove-label', CLAIM_LABEL],
        { json: false, allowFail: true });
    }
  }
  console.log('stale-claim scan completo.');
}

if (process.argv[1]?.endsWith('stale-claim-detector.mjs')) {
  main();
}
