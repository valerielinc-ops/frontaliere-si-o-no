#!/usr/bin/env node
/**
 * Prospector stage 6 — PROMOTE. The stage that closes the loop.
 *
 * Ships graded crawlers into the production set with no human in the path. That
 * is only defensible because the decision is not "the score is high": it is the
 * conjunction in `promotion-gate.mjs`, whose binding condition — two good
 * gradings on two different days — cannot be met by a single run however good
 * that run looks. A crawler synthesised and graded this morning is not eligible
 * this afternoon.
 *
 * What shipping means, concretely: the same `scaffold-crawler.mjs` every
 * hand-written crawler goes through, on the `prospected` tier — parser, runner,
 * unit test, and a `data/crawler-manifest.json` entry that the group-workflow
 * generator folds into a real schedule. The output is indistinguishable from a
 * hand-scaffolded crawler except that its employer-specific knowledge sits in a
 * spec instead of in code.
 *
 * The PR it opens then rides the repo's OWN autonomous cycle — `tests` green,
 * `pr-review-loop`, auto-merge on `## LGTM`. So "no human step" is not a new
 * mechanism invented here; it is the mechanism this repo already runs on, fed
 * by a gate strict enough to deserve it.
 *
 * Blast radius is bounded on purpose: at most `maxPerRun` crawlers per run, and
 * everything that did not pass is reported with its reasons — with nobody
 * watching, the reasons are the audit trail.
 *
 * Usage:
 *   node scripts/prospect-promote.mjs --dry-run
 *   node scripts/prospect-promote.mjs --max=5
 *   node scripts/prospect-promote.mjs --open-pr
 *   node scripts/prospect-promote.mjs --min-days=1 --open-pr   # verifica una tantum
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadCandidates, saveCandidates, setStatus, byStatus } from './lib/prospector/candidate-store.mjs';
import { selectForPromotion, clampMinDays, findOpenPromotionPr, GATE_DEFAULTS } from './lib/prospector/promotion-gate.mjs';
import { loadCoverage } from './lib/prospector/coverage.mjs';
import { ROOT, PROSPECTOR_DIR } from './lib/prospector/config.mjs';
import { checkPrBodySections } from './lib/pr-body-sections-check.mjs';
import { canPushWorkflows } from './ci/followup-drainer.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const flag = (n) => argv.includes(`--${n}`);

const dryRun = flag('dry-run');
const openPr = flag('open-pr');
const maxPerRun = Number(arg('max', GATE_DEFAULTS.maxPerRun));

/**
 * Leva di verifica: abbassa la regola di stabilita' per un giro.
 *
 * Esiste perche' la condizione vincolante del gate — due validazioni buone su
 * due GIORNI distinti — rende impossibile provare il percorso di promozione nel
 * giorno in cui lo si costruisce, e un percorso mai eseguito e' un percorso non
 * verificato. Non e' un modo per allentare il gate di nascosto: e' esposta solo
 * come input di `workflow_dispatch`, il cron non la tocca mai, e ogni uso
 * finisce scritto nel titolo e nel corpo della PR che produce — cosi' una
 * promozione a gate ridotto non puo' essere scambiata per una normale.
 */
// Clamp a 1: `--min-days=0` renderebbe `distinctDays(good) >= 0` sempre vera,
// disattivando del tutto il vincolo sui giorni mentre l'etichetta continua a
// dire «gate ridotto a 1 giorno». Un input di workflow_dispatch non e'
// validato, e una leva che mente su quanto ha allentato e' peggio di nessuna leva.
const minDays = clampMinDays(arg('min-days', GATE_DEFAULTS.minDistinctDays));
const relaxed = minDays < GATE_DEFAULTS.minDistinctDays;
if (relaxed) {
  console.log(`⚠️  GATE RIDOTTO: stabilita' richiesta ${minDays} giorno/i invece di ${GATE_DEFAULTS.minDistinctDays}.`);
  console.log('   Giro di verifica: l\'uso e\' registrato nella PR prodotta.\n');
}

const store = loadCandidates();
const coverage = loadCoverage();
const SPEC_DIR = path.join(PROSPECTOR_DIR, 'crawlers');

/**
 * Porta a termine le promozioni gia' aperte, leggendo l'esito della loro PR.
 *
 * `promoting` e' uno stato di transito e vive SOLO su main, perche' scriverlo
 * anche sul branch della PR farebbe divergere le stesse righe di
 * candidates.json e la PR non sarebbe piu' mergiabile in automatico. Quindi il
 * passaggio finale non puo' che avvenire qui, in un giro successivo:
 *
 *   PR MERGED  -> `production`: il crawler e' in produzione davvero.
 *   PR CLOSED  -> `promoted`: senza questo il candidato resterebbe bloccato per
 *                 sempre, escluso dal gate e non rimesso in gioco da nessuno.
 *   PR OPEN    -> non si tocca: e' ancora in volo.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @returns {{ landed: number, reopened: number }}
 */
function reconcileOpenPromotions(store) {
  let landed = 0;
  let reopened = 0;
  for (const c of byStatus(store, 'promoting')) {
    if (!c.promotionPr) continue;
    let state = '';
    try {
      state = execFileSync('gh', ['pr', 'view', String(c.promotionPr), '--json', 'state', '-q', '.state'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      }).toString().trim();
    } catch { continue; } // gh non disponibile o PR non leggibile: non toccare nulla
    if (state === 'MERGED') {
      setStatus(store, c.key, 'production', { promotedAt: new Date().toISOString() });
      landed++;
    } else if (state === 'CLOSED') {
      setStatus(store, c.key, 'promoted', { reason: `PR ${c.promotionPr} chiusa senza merge, ricandidato` });
      reopened++;
    }
  }
  return { landed, reopened };
}

/**
 * C'e' gia' una PR di promozione aperta?
 *
 * Ogni promozione rigenera TUTTI i 23 `crawler-group-*.yml`, perche' aggiungere
 * un crawler ribilancia i gruppi. Due PR aperte insieme toccano quindi le stesse
 * 23 file dalla stessa base: conflitto garantito, e NESSUNA delle due mergia
 * piu' — misurato su #6292 e #6297, 25 file in comune, entrambe bloccate.
 *
 * Il loop gira ogni notte, quindi senza una serializzazione esplicita il caso e'
 * la norma e non l'eccezione: basta che una PR non mergi entro 24 ore perche' la
 * successiva la blocchi, e da li' in poi non mergia piu' niente.
 *
 * Non si accoda alla PR esistente: quella e' gia' stata revisionata, e
 * aggiungerci commit invaliderebbe il `## LGTM` che le serve per mergiare da
 * sola. Saltare e' anche auto-riparante — i candidati restano `promoted`,
 * quindi il giro dopo il merge li riprende senza che nessuno faccia niente.
 *
 * `--search 'sort:created-desc'` rende esplicito l'ordinamento invece di
 * assumere il default di `gh pr list` (che coincide, ma non era verificato —
 * follow-up #6305 item 1). Il limite e' alto apposta: con l'ordinamento reso
 * esplicito basterebbe l'ultima manciata di PR, ma un limite basso resta un
 * secondo modo silenzioso di perdere la PR di promozione se il backlog di PR
 * aperte cresce oltre la finestra.
 *
 * `ghUnavailable: true` distingue il ramo catch (gh assente/non autorizzato)
 * dal caso reale di PR trovata: senza il flag i due esiti stampavano lo stesso
 * messaggio "PR gia' in volo", e un guasto auth persistente nel runner CI si
 * mimetizzava da comportamento normale invece di segnalarsi come guasto
 * separato (follow-up #6305 item 2).
 *
 * `author` nel campo `--json` alimenta il controllo owner in
 * `findOpenPromotionPr`: senza, un branch aperto a mano con lo stesso
 * prefisso `prospector/promote-` (es. un test manuale) bloccherebbe il loop
 * indefinitamente, scambiato per una promozione reale (follow-up #6305 item 3).
 *
 * @returns {{ number: string, createdAt: string, title: string, ghUnavailable?: boolean }|null}
 */
function openPromotionPr() {
  try {
    const out = execFileSync('gh', [
      'pr', 'list', '--state', 'open', '--search', 'sort:created-desc', '--limit', '300',
      '--json', 'number,createdAt,title,headRefName,author',
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return findOpenPromotionPr(JSON.parse(out));
  } catch {
    // `gh` assente o non autorizzato: non si puo' sapere. Meglio NON promuovere
    // che aprire una seconda PR alla cieca e bloccarle entrambe.
    return { number: '?', createdAt: '', title: 'stato non verificabile', ghUnavailable: true };
  }
}

const reconciled = reconcileOpenPromotions(store);
if (reconciled.landed) console.log(`promozioni atterrate in produzione: ${reconciled.landed}`);
if (reconciled.reopened) console.log(`ricandidati dopo PR chiuse senza merge: ${reconciled.reopened}`);
if (reconciled.landed || reconciled.reopened) saveCandidates(store);

const { promotable, blocked, capped } = selectForPromotion(
  byStatus(store, 'promoted'),
  { existingKeys: coverage.keys },
  { maxPerRun, minDistinctDays: minDays, minRuns: Math.min(GATE_DEFAULTS.minRuns, Math.max(1, minDays)) },
);

const inFlight = openPromotionPr();
if (inFlight) {
  console.log('═══ Prospector · PROMOTE ═══');
  if (inFlight.ghUnavailable) {
    // Guasto separato dal caso "PR trovata": non sappiamo se una promozione e'
    // gia' in volo, quindi saltiamo per sicurezza — ma un problema di
    // auth/token persistente nel runner CI deve segnalarsi come tale, non
    // mimetizzarsi da normale serializzazione.
    console.log('\n⚠️  gh non risponde (assente o non autorizzato): impossibile verificare');
    console.log('se una PR di promozione e\' gia\' aperta. Salto la promozione per sicurezza.');
    console.log('Questo NON e\' il caso normale di "PR gia\' in volo": se persiste su piu\' run,');
    console.log('e\' un guasto di auth/token del runner CI da investigare separatamente.');
    process.exit(0);
  }
  const ageH = inFlight.createdAt
    ? Math.round((Date.now() - Date.parse(inFlight.createdAt)) / 3600000)
    : null;
  console.log(`\nUna PR di promozione e' gia' aperta: #${inFlight.number}${ageH !== null ? ` (da ${ageH}h)` : ''}`);
  console.log(`  ${inFlight.title}`);
  console.log('\nNon ne apro una seconda: ogni promozione rigenera tutti i gruppi di');
  console.log('workflow, quindi due PR aperte si bloccherebbero a vicenda sugli stessi file.');
  console.log('I candidati restano in coda e il giro dopo il merge li riprende da solo.');
  if (ageH !== null && ageH > 48) {
    console.log(`\n⚠️  Quella PR e' ferma da ${ageH}h: finche' non mergia, il loop non promuove piu' nessuno.`);
  }
  process.exit(0);
}

console.log('═══ Prospector · PROMOTE ═══');
console.log(`candidati graduati "promoted": ${byStatus(store, 'promoted').length}`);
console.log(`passano il gate di produzione: ${promotable.length}${capped ? ` (+${capped} oltre il tetto di ${maxPerRun}, rinviati)` : ''}`);
console.log(`fermati dal gate: ${blocked.length}\n`);

// Why each one was held back. With nobody watching, this IS the review.
const reasonTally = {};
for (const b of blocked) for (const r of b.reasons) reasonTally[r] = (reasonTally[r] || 0) + 1;
for (const [reason, n] of Object.entries(reasonTally).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(4)} × ${reason}`);
}

if (!promotable.length) {
  console.log('\nNiente da promuovere in questo giro.');
  process.exit(0);
}

console.log('\n── in promozione ──');
const shipped = [];
for (const c of promotable) {
  const specPath = path.join(SPEC_DIR, `${c.crawlerKey}.json`);
  let spec;
  try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); } catch {
    console.log(`  ✗ ${c.crawlerKey}: spec mancante, salto`);
    continue;
  }
  // Un seed vuoto renderebbe `--url` un `undefined` passato a execFileSync, che
  // fallisce in modo oscuro a meta' scaffolding. Meglio saltare e dirlo.
  if (!Array.isArray(spec.seedUrls) || !spec.seedUrls[0]) {
    console.log(`  ✗ ${c.crawlerKey}: spec senza seed URL, salto`);
    continue;
  }
  const args = [
    'scripts/scaffold-crawler.mjs', spec.companyKey,
    '--name', spec.companyName,
    '--domain', spec.companyHost,
    '--lang', spec.sourceLang || 'it',
    '--ats', 'prospected',
    '--url', spec.seedUrls[0],
  ];
  if (dryRun) {
    console.log(`  · ${spec.companyKey.padEnd(28)} ${String(c.vacancyCount).padStart(3)} annunci  (dry-run)`);
    shipped.push({ ...c, spec });
    continue;
  }
  try {
    execFileSync('node', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // Prima riga utile invece dei primi 160 caratteri: uno stack di Node inizia
    // con il path del modulo interno e la riga di `throw`, quindi il troncamento
    // mostrava tre righe di rumore e nascondeva la causa. Nel primo giro
    // autonomo l'errore leggibile era `ERR_MODULE_NOT_FOUND: yaml` e nel log si
    // vedeva solo `Error [ERR_MODULE_NOT_FOUND]:`.
    const raw = String(err.stderr || err.message || '');
    const cause = raw.split('\n')
      .map((l) => l.trim())
      .find((l) => /^(Error|[A-Za-z]*Error:)/.test(l) && l.length > 12) || raw.split('\n')[0] || 'causa ignota';
    const named = /Cannot find package '([^']+)'/.exec(raw)?.[1];
    const missing = named || (/ERR_MODULE_NOT_FOUND/.test(raw) ? 'dipendenza npm' : '');
    console.log(`  ✗ ${spec.companyKey}: scaffold fallito — ${cause}${missing ? ` (manca: ${missing})` : ''}`);
    continue;
  }
  // NIENTE cambio di stato qui.
  //
  // Scriverlo sul branch della PR era un conflitto Git garantito: il branch
  // avrebbe scritto `production` e main `promoting` per gli stessi candidati,
  // dalla stessa base e sulle stesse righe di candidates.json (`status` sta su
  // una riga propria, e non c'e' merge driver per questo file). La PR sarebbe
  // risultata non-mergeable e ogni promozione RIUSCITA avrebbe richiesto un
  // intervento umano — il percorso normale, non un caso limite, e l'esatto
  // contrario di un loop che si chiude da solo.
  //
  // L'evidenza della promozione, sul branch, sono i file scaffoldati e la voce
  // di manifest. Lo stato lo scrive solo main: `promoting` adesso, `production`
  // quando un giro successivo vede che la PR e' stata mergiata.
  shipped.push({ ...c, spec });
  console.log(`  ✓ ${spec.companyKey.padEnd(28)} ${String(c.vacancyCount).padStart(3)} annunci  qualita' ${Number(c.qualityScore).toFixed(2)}`);
}

if (dryRun) {
  console.log('\n--dry-run: niente scritto.');
  process.exit(0);
}

if (!shipped.length) {
  // Il gate si e' aperto e non e' uscito NIENTE: non e' un giro tranquillo, e'
  // un guasto. Uscire 0 lo rendeva invisibile — il primo giro autonomo ha
  // promosso 10 crawler, ne ha scaffoldati zero per una dipendenza mancante, e
  // il workflow e' finito verde. Con nessuno che guarda, un fallimento totale
  // silenzioso e' l'esito peggiore possibile.
  console.error(`\n❌ ${promotable.length} candidati hanno superato il gate e NESSUNO e' stato scaffoldato.`);
  console.error('   Le cause sono nelle righe ✗ qui sopra.');
  process.exit(1);
}

// ── Il registro pubblico delle aziende, rigenerato QUI e non altrove ──────
//
// `data/crawler-companies-auto.json` alimenta la directory aziende del sito, e
// si costruisce leggendo `scripts/update-*-jobs.mjs`. Cioe': e' una funzione
// dell'insieme dei crawler in produzione, e cambia esattamente quando cambia
// quell'insieme — che e' qui, in questo stadio, e in nessun altro punto del
// repo.
//
// Non era agganciato a niente. `npm run companies:generate` esisteva e nessuno
// lo chiamava: misurato sulla issue #6481, il file era fermo a 213 voci contro
// 614 runner reali, cioe' 401 datori con un crawler dedicato che non comparivano
// nella directory pubblica. La PR #6527 ha corretto la QUALITA' di cio' che il
// generatore produce quando gira; questa riga e' cio' che lo fa girare.
//
// Sta DOPO il guard `!shipped.length` apposta: un giro che non promuove nessuno
// non ha cambiato l'insieme dei crawler, quindi non ha niente da rigenerare — e
// un file riscritto identico e' comunque un commit vuoto in piu' da spiegare.
// Sta PRIMA del blocco `git add`/`commit`/`gh pr create` piu' sotto, cosi' il
// diff rigenerato viaggia nello stesso commit dei runner che l'hanno causato,
// invece di lasciare `main` incoerente fino al prossimo intervento a mano.
//
// Non e' agganciato a `audit-duplicate-crawlers.yml`: quello e' un audit
// giornaliero in sola lettura, e un dataset che deve stare sincrono con OGNI
// promozione non puo' dipendere da un ciclo di 24 ore.
let companiesRegenerated = false;
try {
  execFileSync('node', ['scripts/generate-crawler-companies.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  companiesRegenerated = true;
  console.log('\nregistro aziende rigenerato (data/crawler-companies-auto.json)');
} catch (err) {
  // NON si interrompe la promozione: i crawler scaffoldati sono lavoro valido e
  // gia' sul disco, e buttarli via perche' un file di dati derivato non si e'
  // rigenerato sarebbe sproporzionato — il registro si riallinea al giro dopo.
  //
  // Ma il file NON entra nel commit (vedi `paths`), e questo e' l'unico motivo
  // per cui il ramo e' sicuro: la scrittura del generatore e' atomica
  // (tmp + rename, vedi `generate-crawler-companies.mjs`), quindi «fallita» qui
  // significa davvero «il file precedente e' intatto», non «meta' file sul
  // disco». Senza quella garanzia questo `catch` committerebbe un JSON troncato
  // dentro una PR che nessuno legge.
  console.log(`\n⚠️ rigenerazione del registro aziende fallita: ${String(err.stderr || err.message).slice(0, 200)}`);
  console.log('   I crawler entrano comunque; la directory aziende resta alla versione precedente.');
}

// Rigenerare i gruppi tocca `.github/workflows/**`, e GitHub rifiuta per
// progetto che una App scriva li' senza il permesso `workflows`. Il permesso
// non si deduce dalla PRESENZA del token: il conio riesce lo stesso quando
// l'installazione non ce l'ha (issue #5288), e il rifiuto arriva solo alla
// fine, al push — misurato qui: 10 crawler scaffoldati e poi
// «refusing to allow a GitHub App to create or update workflow».
//
// Fail-closed: si rigenera solo se la capacita' e' stata LETTA da una risposta
// dell'API. Senza, il crawler entra comunque (parser, runner, test, voce di
// manifest) e resta solo da schedulare — una PR in meno di valore, non una PR
// bloccata.
//
// `canPushWorkflows()` e non `process.env.APP_TOKEN_WORKFLOWS` diretto: quella
// env descrive UNA sola identita' (la GitHub App), e leggerla da sola e' la
// stessa forma di difetto corretta il 2026-09-04 nel pre-flight del drainer —
// dove sul corpus, che pusha con un PAT classico con scope `workflow`, la
// risposta era `false` per costruzione. Qui oggi il risultato non cambia (il
// loop del prospector gira con la App e non scrive `PAT_WORKFLOWS_SCOPE`), ma
// la capacita' si legge da entrambe le sorgenti in un posto solo.
const canWriteWorkflows = canPushWorkflows();
let groupsRegenerated = false;
if (canWriteWorkflows) {
  try {
    execFileSync('node', ['scripts/generate-crawler-group-workflows.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    groupsRegenerated = true;
    console.log('\ngruppi di workflow rigenerati');
  } catch (err) {
    console.log(`\n⚠️ rigenerazione gruppi fallita: ${String(err.stderr || err.message).slice(0, 200)}`);
  }
} else {
  console.log('\n⚠️ niente permesso `workflows` su questo token: i gruppi NON vengono rigenerati.');
  console.log('   I crawler entrano comunque; restano da schedulare.');
}

// NIENTE `saveCandidates` qui.
//
// Dal fix #6258 il branch non cambia piu' lo stato dei candidati, quindi questa
// scrittura produceva un unico diff: il timestamp `updatedAt` di primo livello.
// Main lo riscrive a OGNI giro del loop, quindi ogni PR di promozione arrivava
// al merge con un conflitto garantito su quella riga — misurato su #6292 e
// #6297, unico file in conflitto, una riga, zero informazione.
//
// Lo stato lo scrive solo main, dopo l'apertura della PR. E' la stessa
// disciplina del fix #6258, portata fino in fondo.

/* ── The PR, for the repo's own autonomous cycle to review and merge ──── */
if (!openPr) {
  console.log('\n(--open-pr non passato: file scritti, nessuna PR aperta)');
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10);
// Il cron gira una volta al giorno, ma un workflow_dispatch manuale nello stesso
// giorno userebbe lo stesso nome e `git checkout -b` fallirebbe: la promozione di
// quel giro andrebbe persa senza che nulla lo dica.
const baseBranch = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch { return 'main'; }
})();
const branchExists = (name) => {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { /* non locale */ }
  try {
    const out = execFileSync('git', ['ls-remote', '--heads', 'origin', name], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    return out.length > 0;
  } catch { return false; }
};
let branch = `prospector/promote-${stamp}`;
for (let n = 2; branchExists(branch) && n < 20; n++) branch = `prospector/promote-${stamp}-${n}`;
const totalVacancies = shipped.reduce((a, s) => a + (s.vacancyCount || 0), 0);

const bullets = shipped.map((s) => {
  const h = (s.validationHistory || []).filter((v) => v.verdict === 'good');
  const days = new Set(h.map((v) => String(v.at).slice(0, 10))).size;
  return `- **in questa PR** — \`${s.spec.companyKey}\` · ${s.spec.companyName} · ${s.vacancyCount} annunci · qualita' ${Number(s.qualityScore).toFixed(2)} su ${days} giorni distinti · estrazione \`${s.spec.mode}\` · ${s.spec.companyHost}`;
}).join('\n');

const relaxedNote = relaxed
  ? `\n- **in questa PR** — ⚠️ **giro di verifica a gate ridotto**: stabilita' richiesta ${minDays} giorno/i invece di ${GATE_DEFAULTS.minDistinctDays}. Serviva a eseguire il percorso di promozione senza attendere il secondo giorno; tutte le altre condizioni del gate sono quelle normali. Il cron non usa mai questa leva.`
  : '';

// Il registro aziende e' un file di dati PUBBLICO che questo diff modifica: se
// il body non lo nomina, e' esattamente il gap di #6301/#6279 — un file
// funnel-critical nel diff e mai citato nel corpo. Il ramo negativo non e'
// silenzio: dice che il file resta alla versione precedente, cosi' chi legge la
// PR sa che la directory aziende e' indietro di questi crawler.
const companiesNote = companiesRegenerated
  ? `
- **in questa PR** — \`data/crawler-companies-auto.json\` rigenerato nello stesso commit dei runner: la directory aziende del sito resta allineata all'insieme dei crawler realmente in produzione, invece di dipendere da un \`npm run companies:generate\` lanciato a mano (era fermo a 213 voci su 614 runner, issue #6481).`
  : `
- **blocked: la rigenerazione del registro aziende e' fallita in questo giro** — \`data/crawler-companies-auto.json\` resta alla versione precedente e non copre questi crawler; la scrittura del generatore e' atomica, quindi il file NON e' troncato. La causa e' nel log dello stadio PROMOTE e \`npm run companies:generate\` la riproduce.`;

const body = `## Implementato

- **in questa PR** — ${shipped.length} crawler promossi dal prospector, per **${totalVacancies} annunci** di datori che non coprivamo. Ognuno ha superato il gate di \`scripts/lib/prospector/promotion-gate.mjs\`: qualita' >= ${GATE_DEFAULTS.minScore} contro la pagina ufficiale del datore, su almeno ${GATE_DEFAULTS.minSampled} pagine di dettaglio, con **${GATE_DEFAULTS.minRuns} validazioni buone su ${GATE_DEFAULTS.minDistinctDays} giorni distinti** — la condizione che una singola run, per quanto buona, non puo' soddisfare — e con almeno il ${Math.round(GATE_DEFAULTS.minJobLike * 100)}% delle pagine di dettaglio che **legge come un annuncio di lavoro** e non come contenuto promozionale o editoriale.
${bullets}${relaxedNote}
- **in questa PR** — voci nel manifest${groupsRegenerated ? ' e gruppi di workflow rigenerati, quindi i crawler entrano nella schedulazione esistente' : ''}.${groupsRegenerated ? '' : `
- **blocked: manca il permesso \`workflows\` sul token** — i gruppi non sono stati rigenerati, quindi questi crawler esistono ma non sono ancora schedulati. Basta un \`node scripts/generate-crawler-group-workflows.mjs\` da un'identita' che possa scrivere in \`.github/workflows/\`.`}${companiesNote}

## Non implementato (ancora)

- **by construction** — nessun parser scritto a mano: cio' che e' specifico del datore vive nella spec dichiarativa sotto \`data/prospector/crawlers/\`, e l'estrazione in produzione e' la stessa che il gate ha misurato.
- **per scelta** — al massimo ${maxPerRun} crawler per giro. Una pipeline non presidiata che ne aggiunge dieci al giorno e' recuperabile, una che ne aggiunge quattrocento no.
- **blocked: serve una run successiva** — ${blocked.length} candidati graduati non hanno superato il gate; le cause sono nel log dello stadio PROMOTE e la piu' frequente e' la stabilita' su due giorni, che si risolve da sola al giro dopo.
`;

// Il body sopra non cita mai i file `.github/workflows/**` che
// `generate-crawler-group-workflows.mjs` puo' aver toccato quando
// `groupsRegenerated` (solo la frase generica "gruppi di workflow rigenerati") —
// stesso gap di #6301/#6279: un file funnel-critical modificato dal diff e mai
// nominato nel body. `diffPaths` alimenta quel check qui, non solo nel gate CI.
function changedWorkflowPaths() {
  try {
    const workflowPaths = ['.github/workflows', '.github/corpus-workflows'];
    const modified = execFileSync('git', ['diff', '--name-only', '--', ...workflowPaths], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...workflowPaths], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return [...modified.split('\n'), ...untracked.split('\n')].map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Autocontrollo del corpo PRIMA di aprire la PR. Senza nessuno che guarda, un
// body che non soddisfa il contratto del repo non e' un fastidio: la PR resta
// ferma per sempre, e il loop continua a produrne altre uguali.
const contract = checkPrBodySections(body, {
  diffPaths: groupsRegenerated ? changedWorkflowPaths() : [],
});
if (!contract.ok) {
  console.error('\n❌ il corpo della PR non soddisfa il contratto del repo, non apro nulla:');
  for (const v of contract.violations) console.error(`   - [${v.type}] ${v.message}`);
  process.exit(1);
}
for (const w of contract.warnings || []) console.log(`  ⚠️ ${w.type}: ${String(w.message).slice(0, 120)}`);

const bodyFile = path.join(PROSPECTOR_DIR, 'promote-pr-body.md');
fs.writeFileSync(bodyFile, body);

const git = (...a) => execFileSync('git', a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
try {
  git('checkout', '-b', branch);
  // `data/prospector` NON entra nel commit del branch: la coda e le spec sono
  // gia' su main (le committa lo stadio precedente), e includerle qui aggiunge
  // solo righe che main muove sotto i piedi della PR.
  const paths = ['scripts', 'tests', 'data/crawler-manifest.json'];
  // Il registro aziende entra solo se la rigenerazione e' RIUSCITA. Vedi il
  // `catch` piu' sopra: un fallimento deve lasciare nel diff il file vecchio
  // intatto, non trascinarcene dentro uno a meta'.
  if (companiesRegenerated) paths.push('data/crawler-companies-auto.json');
  // `data/crawler-group-assignments.json` va nello STESSO commit dei .yml, non
  // e' opzionale: dal #6482 e' li' che vive l'assegnazione crawler->gruppo, e i
  // .yml ne sono la resa. Committare i .yml senza i pin lascia il nuovo crawler
  // "mai visto" al giro dopo, che lo riassegna a un gruppo qualunque — cioe'
  // esattamente il rimescolamento che i pin esistono per impedire.
  if (groupsRegenerated) paths.push(
    '.github/workflows',
    '.github/corpus-workflows',
    'data/crawler-group-assignments.json',
  );
  git('add', ...paths);
  git('commit', '-m', `prospector: promuove ${shipped.length} crawler validati (${totalVacancies} annunci)`);
  git('push', '-u', 'origin', branch);
  const url = execFileSync('gh', [
    'pr', 'create', '--base', 'main', '--head', branch,
    '--title', `${relaxed ? '[gate ridotto] ' : ''}Prospector: promuove ${shipped.length} crawler validati (${totalVacancies} annunci)`,
    '--body-file', bodyFile,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  console.log(`\nPR aperta: ${url}`);

  // Il passaggio a `production` vive sul branch della PR, quindi su main questi
  // candidati resterebbero `promoted` finche' la PR non merge — e il giro
  // successivo, che riparte da main fresco, li riscaffolderebbe aprendo una
  // seconda PR con gli stessi file. Quindi si torna sul branch base e ci si
  // scrive `promoting` con il numero di PR: e' l'unico stato che il giro dopo
  // vedra' davvero.
  const prNumber = (url.match(/\/pull\/(\d+)/) || [])[1] || url;
  git('checkout', baseBranch);
  const mainStore = loadCandidates();
  for (const s of shipped) {
    setStatus(mainStore, s.key, 'promoting', { promotionPr: prNumber, promotionBranch: branch });
  }
  saveCandidates(mainStore);
  try {
    git('add', 'data/prospector');
    git('commit', '-m', `prospector: segna ${shipped.length} candidati come in promozione (PR ${prNumber})`);
    git('push', 'origin', baseBranch);
    console.log(`stato "promoting" scritto su ${baseBranch}: il giro successivo non li riproporra'.`);
  } catch (err) {
    console.error(`⚠️ non sono riuscito a scrivere lo stato su ${baseBranch}: ${String(err.stderr || err.message).slice(0, 200)}`);
    console.error('   Il giro successivo potrebbe riproporre questi candidati.');
  }
  console.log('Il ciclo del repo revisiona e mergia la PR da solo su ## LGTM.');
} catch (err) {
  console.error(`\n❌ apertura PR fallita: ${String(err.stderr || err.message).slice(0, 400)}`);
  process.exit(1);
}
