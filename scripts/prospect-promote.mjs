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
import { selectForPromotion, clampMinDays, GATE_DEFAULTS } from './lib/prospector/promotion-gate.mjs';
import { loadCoverage } from './lib/prospector/coverage.mjs';
import { ROOT, PROSPECTOR_DIR } from './lib/prospector/config.mjs';
import { checkPrBodySections } from './lib/pr-body-sections-check.mjs';

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

const reconciled = reconcileOpenPromotions(store);
if (reconciled.landed) console.log(`promozioni atterrate in produzione: ${reconciled.landed}`);
if (reconciled.reopened) console.log(`ricandidati dopo PR chiuse senza merge: ${reconciled.reopened}`);
if (reconciled.landed || reconciled.reopened) saveCandidates(store);

const { promotable, blocked, capped } = selectForPromotion(
  byStatus(store, 'promoted'),
  { existingKeys: coverage.keys },
  { maxPerRun, minDistinctDays: minDays, minRuns: Math.min(GATE_DEFAULTS.minRuns, Math.max(1, minDays)) },
);

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
    console.log(`  ✗ ${spec.companyKey}: scaffold fallito — ${String(err.stderr || err.message).slice(0, 160)}`);
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

if (!shipped.length || dryRun) {
  if (dryRun) console.log('\n--dry-run: niente scritto.');
  process.exit(0);
}

// Fold the new crawlers into a group workflow, so they actually get scheduled.
try {
  execFileSync('node', ['scripts/generate-crawler-group-workflows.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('\ngruppi di workflow rigenerati');
} catch (err) {
  console.log(`\n⚠️ rigenerazione gruppi fallita: ${String(err.stderr || err.message).slice(0, 200)}`);
}

saveCandidates(store);

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

const body = `## Implementato

- **in questa PR** — ${shipped.length} crawler promossi dal prospector, per **${totalVacancies} annunci** di datori che non coprivamo. Ognuno ha superato il gate di \`scripts/lib/prospector/promotion-gate.mjs\`: qualita' >= ${GATE_DEFAULTS.minScore} contro la pagina ufficiale del datore, su almeno ${GATE_DEFAULTS.minSampled} pagine di dettaglio, con **${GATE_DEFAULTS.minRuns} validazioni buone su ${GATE_DEFAULTS.minDistinctDays} giorni distinti** — la condizione che una singola run, per quanto buona, non puo' soddisfare.
${bullets}${relaxedNote}
- **in questa PR** — voci nel manifest e gruppi di workflow rigenerati, quindi i crawler entrano nella schedulazione esistente.

## Non implementato (ancora)

- **by construction** — nessun parser scritto a mano: cio' che e' specifico del datore vive nella spec dichiarativa sotto \`data/prospector/crawlers/\`, e l'estrazione in produzione e' la stessa che il gate ha misurato.
- **per scelta** — al massimo ${maxPerRun} crawler per giro. Una pipeline non presidiata che ne aggiunge dieci al giorno e' recuperabile, una che ne aggiunge quattrocento no.
- **blocked: serve una run successiva** — ${blocked.length} candidati graduati non hanno superato il gate; le cause sono nel log dello stadio PROMOTE e la piu' frequente e' la stabilita' su due giorni, che si risolve da sola al giro dopo.
`;

// Autocontrollo del corpo PRIMA di aprire la PR. Senza nessuno che guarda, un
// body che non soddisfa il contratto del repo non e' un fastidio: la PR resta
// ferma per sempre, e il loop continua a produrne altre uguali.
const contract = checkPrBodySections(body);
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
  git('add', 'scripts', 'tests', 'data/crawler-manifest.json', '.github/workflows', 'data/prospector');
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
