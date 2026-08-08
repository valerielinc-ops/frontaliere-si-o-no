/**
 * parked-pr-detector.mjs — segnala le PR che NESSUN processo automatico
 * toccherà mai più (zero-Claude, deterministico).
 *
 * ## Il buco che chiude
 *
 * Il ciclo ha una rete a più strati per le PR ferme, e ogni strato salta le
 * draft — per ragioni buone, ognuna documentata dove sta:
 *
 *   - `pr-review-loop`      → «PR #N è draft → skip review».
 *   - `auto-merge-eval`     → «PR #N è draft — skip».
 *   - `auto-merge-sweep`    → `selectSweepCandidates` filtra `isDraft`.
 *   - `pr-autorebase`       → `filter((p) => !p.isDraft)`.
 *   - `stale-pr-rescuer`    → «Le draft NON vanno toccate», ed è NECESSARIO per
 *                             la sua classe C.
 *   - `recycle-stale-prs`   → agisce solo sulle PR già `stale-review`, che una
 *                             draft non riceve mai (per il punto sopra).
 *
 * Ogni singolo skip è giusto. La loro SOMMA non lo è: una draft aperta è fuori
 * da ogni strato contemporaneamente. Non viene revisionata, non viene mergiata,
 * non viene rebasata, non viene etichettata stale e quindi non viene riciclata.
 * Resta aperta finché un umano non ci inciampa — e nessuno gli dice di farlo.
 *
 * È successo: la PR #33 di `frontaliere-articles`, uno snapshot di sessione morta aperto
 * come draft «⛔️ NON MERGIARE» per rimandare una decisione. Il contenitore
 * sbagliato ha reso la decisione invisibile invece che rimandata, e nel
 * frattempo i suoi 29 file funnel-critical restavano nel grafo delle collisioni
 * (`pr-collision-detector` era l'unico strato a NON saltare le draft — corretto
 * in valerielinc-ops/frontaliere-si-o-no#5364).
 *
 * ## Cosa fa, e cosa deliberatamente non fa
 *
 * Applica `needs-human` + UN commento idempotente. Nient'altro: niente close,
 * niente push, niente re-queue. Una draft parcheggiata può benissimo essere un
 * WIP legittimo, e chiuderla d'ufficio distruggerebbe lavoro vero — l'errore
 * opposto e peggiore. Serve visibilità, non un'azione.
 *
 * `needs-human` non è una label nuova: `recycle-stale-prs.yml` ha già uno step
 * che ne fa un digest giornaliero deduplicato («nessun processo automatico le
 * sbloccherà. Servono occhi umani»). Riusarla significa che il segnale finisce
 * in un canale che esiste già ed è già letto, invece di aprirne un secondo che
 * nessuno guarda.
 *
 * Uso:  node scripts/ci/parked-pr-detector.mjs [--dry-run]
 * Env:  GH_TOKEN, GITHUB_REPOSITORY, PARKED_HOURS (default 48).
 */
import { execFileSync } from 'node:child_process';
import { commentOnce as commentOnceShared } from './lib/prComments.mjs';

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GITHUB_REPOSITORY || '';
const PARKED_LABEL = 'needs-human';

/** Default 48h e non 24: sotto le 24 una draft aperta ieri sera è ancora WIP. */
export const DEFAULT_PARKED_HOURS = 48;

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
 * Quali PR sono parcheggiate: draft, ferme da più di `maxAgeHours`, senza già
 * la label.
 *
 * Puro → testabile. `nowMs` è un parametro e non `Date.now()` per la stessa
 * ragione: una soglia temporale testata contro l'orologio reale è un test che
 * cambia risposta a seconda di quando gira.
 *
 * Solo le draft. Una PR non-draft ferma è già coperta da `stale-pr-rescuer`
 * (classi A/B/C → `stale-review`) e poi da `recycle-stale-prs`: allargare qui
 * duplicherebbe quel percorso e produrrebbe due segnali per lo stesso stallo.
 * `updatedAt` illeggibile → NON parcheggiata: in dubbio si tace, perché il
 * costo di un falso positivo è una label sbagliata su una PR viva.
 */
export function selectParkedPrs(prs, nowMs, maxAgeHours = DEFAULT_PARKED_HOURS) {
  if (!Array.isArray(prs)) return [];
  const cutoff = nowMs - maxAgeHours * 3600 * 1000;
  return prs.filter((p) => {
    if (!p || !Number.isInteger(p.number)) return false;
    if (p.isDraft !== true) return false;
    if ((p.labels || []).some((l) => l && l.name === PARKED_LABEL)) return false;
    const updated = Date.parse(p.updatedAt || '');
    if (!Number.isFinite(updated)) return false;
    return updated < cutoff;
  });
}

function main() {
  if (!REPO) { console.error('GITHUB_REPOSITORY mancante'); process.exit(1); }
  const hours = Number(process.env.PARKED_HOURS) || DEFAULT_PARKED_HOURS;
  console.log(`parked-pr-detector${DRY ? ' [DRY-RUN]' : ''} repo=${REPO} soglia=${hours}h`);

  let prs;
  try {
    prs = gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '100',
      '--json', 'number,title,isDraft,updatedAt,labels']);
  } catch (e) {
    // Non fallire il job: questo è un segnale, non un gate.
    console.error(`gh pr list fallito: ${String(e).slice(0, 160)} — skip.`);
    process.exit(0);
  }

  const parked = selectParkedPrs(prs || [], Date.now(), hours);
  if (!parked.length) { console.log('Nessuna PR parcheggiata.'); return; }
  console.log(`PR parcheggiate: ${parked.length}`);

  for (const pr of parked) {
    console.log(`  #${pr.number} draft, fermo dal ${pr.updatedAt} — ${String(pr.title).slice(0, 80)}`);
    // ORDINE LOAD-BEARING: prima il commento, poi la label.
    //
    // Le due chiamate sono `gh` indipendenti e `allowFail`, quindi una delle
    // due puo' fallire da sola (rate limit, blip). Con la label per prima, un
    // commento fallito non veniva mai piu' riprovato: `selectParkedPrs`
    // esclude chi ha gia' `needs-human`, quindi al run successivo la PR era
    // saltata e restava etichettata per sempre SENZA la spiegazione — cioe'
    // proprio il pezzo che dice all'umano cosa fare, che e' l'unico scopo di
    // questo detector.
    //
    // Invertendo, ogni combinazione converge:
    //   comment ok  + label ko  → il run dopo la ri-seleziona (niente label),
    //                             `commentOnce` vede il marker e non duplica,
    //                             la label viene riprovata.
    //   comment ko  + (label non applicata) → ri-selezionata, riprova entrambi.
    //   entrambi ok → esclusa dalla label, marker gia' presente. Idempotente.
    commentOnceShared(gh, REPO, pr.number, '<!-- PARKED-DRAFT -->',
      `🅿️ **PR parcheggiata**: è in draft e ferma da più di ${hours}h.\n\n` +
      'Una draft è fuori da **tutti** gli strati del ciclo insieme — review, auto-merge, ' +
      'sweep, autorebase, stale-rescuer — quindi da qui in poi non si muove da sola: ' +
      'nessun processo la revisionerà, la mergerà o la chiuderà. Etichettata `needs-human` ' +
      'perché compaia nel digest giornaliero di `recycle-stale-prs.yml` invece di restare ' +
      'invisibile.\n\n' +
      'Tre uscite, tutte migliori del lasciarla lì:\n\n' +
      '1. **È lavoro vivo** → togli il draft. Rientra nel ciclo e da lì si muove da sola.\n' +
      '2. **È lavoro morto** → chiudila. Se i byte servono, un tag li conserva senza tenere ' +
      'armato niente: `gh api repos/$REPO/git/refs -f ref=refs/tags/snapshot/<nome> -f sha=<head>`. ' +
      'Nessun workflow di questo repo ha trigger `tags:`.\n' +
      '3. **Serve una decisione** → prendila qui nei commenti e poi 1 o 2. Una PR non è un ' +
      'archivio: è una *richiesta di merge*, e usarla come deposito le fa fare l\'unica cosa ' +
      'che non deve fare.\n\n' +
      '_Segnale deterministico da parked-pr-detector.mjs (zero-Claude). Il commento non si ripete._',
      { dry: DRY });

    if (DRY) { console.log(`  [dry] +label ${PARKED_LABEL} #${pr.number}`); }
    else {
      gh(['pr', 'edit', String(pr.number), '--repo', REPO, '--add-label', PARKED_LABEL],
        { json: false, allowFail: true });
    }
  }
  console.log('parked scan completo.');
}

if (process.argv[1]?.endsWith('parked-pr-detector.mjs')) {
  main();
}
