#!/usr/bin/env node
/**
 * check-quota-backoff.mjs — zero-Claude PRE-FLIGHT gate per issue-fix.yml.
 *
 * STRUCTURAL fix per la classe misurata il 2026-08-05 sul tracker #1951: nella
 * finestra 7gg 2026-07-29 → 2026-08-05, `issue-fix.yml` ha registrato 61 run
 * fallite su 117 reali (52%) e **60 di quelle 61 sono HTTP 429** (quota Max
 * settimanale esaurita), con `num_turns: 1` e `total_cost_usd: 0` — cioè Claude
 * non ha mai eseguito. Zero `error_max_turns`, zero fallimenti di push/PR, zero
 * timeout. Rationale completo + catena assorbente in `claude-rate-limit.mjs`.
 *
 * Il punto che questo gate risolve: **49 delle 61 run fallite (80%) sono
 * avvenute dentro una finestra di rate-limit GIÀ APERTA da un fallimento
 * precedente**. Erano deterministicamente prevedibili — il payload del 429
 * dichiara `resetsAt`, l'epoch esatto in cui la quota torna — eppure il loop
 * continuava a promuovere una issue dopo l'altra ogni ~5 minuti contro un muro
 * noto, ognuna bruciando lo slot serializzato `concurrency: issue-fix` e
 * ritardando tutta la coda.
 *
 * ## Come funziona il beacon (nessuno store esterno)
 *
 * Non serve una variabile di repo né un file committato: la finestra vive già
 * sulle issue. Quando una run muore di 429, il fixer posta sulla issue
 * `<!-- FIX_OUTCOME: rate-limited -->` + `<!-- QUOTA_RESETS_AT: <epoch> -->`.
 * Quel commento È il beacon. Questo gate cerca il beacon più recente fra le
 * issue attualmente in lavorazione/coda (`agent:fix` / `agent:fix-queued`) e, se
 * la scadenza non è passata, corto-circuita la run PRIMA dello step Claude.
 *
 * La ricerca è bounded per costo: solo issue toccate nelle ultime
 * `QUOTA_BEACON_LOOKBACK_H` ore (un beacon è fresco per definizione), ordinate
 * dalla più recente, cap `QUOTA_BEACON_MAX_ISSUES` letture `gh issue view`. In
 * regime normale la coda tiene 1-2 issue con quelle label, quindi il gate costa
 * 2 list + ≤1 view.
 *
 * Output (GITHUB_OUTPUT): `quota_blocked=true|false`, `resets_at=<epoch|''>`.
 *   - true  → finestra aperta: la issue viene RI-ACCODATA (`agent:fix` →
 *             `agent:fix-queued`) e il workflow salta ogni step Claude. Nessun
 *             tentativo consumato: la run non ha letto la issue, non è un
 *             fallimento del fixer.
 *   - false → nessuna finestra attiva → il fixer gira invariato.
 *
 * PROCEED-SAFE (stesso contratto di check-issue-already-resolved.mjs /
 * check-workflows-scope.mjs / claim-issue-in-flight.mjs): qualunque errore
 * gh/API/parse → `quota_blocked=false`. Un gate rotto non deve MAI congelare la
 * coda; al massimo si torna al comportamento pre-fix (una run sprecata).
 *
 * Env:
 *   GH_TOKEN                  necessario per gh (Actions GITHUB_TOKEN basta).
 *   GH_REPO                   opzionale `owner/repo`.
 *   ISSUE_NUMBER              opzionale: la issue di questa run, da ri-accodare.
 *   QUOTA_BEACON_LOOKBACK_H   default 24.
 *   QUOTA_BEACON_MAX_ISSUES   default 12.
 *   QUOTA_LBL_ACTIVE          label della run corrente (default `agent:fix`;
 *                             `issue-decompose.yml` passa `agent:decompose`).
 *   QUOTA_LBL_REQUEUE         coda di ri-accodo (default `agent:fix-queued`).
 *   DRY_RUN                   "1" → nessuna scrittura, output comunque emesso.
 *   GITHUB_OUTPUT             file di output dello step Actions.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBackoffActive, maxQuotaResetsAt } from './claude-rate-limit.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const ISSUE = process.env.ISSUE_NUMBER;
const LOOKBACK_H = Number(process.env.QUOTA_BEACON_LOOKBACK_H || 24);
const MAX_ISSUES = Number(process.env.QUOTA_BEACON_MAX_ISSUES || 12);
const LBL_FIX = 'agent:fix';
const LBL_QUEUED = 'agent:fix-queued';
// Stadio di decomposizione (2026-08-21): stesso gate, label diverse. Il
// chiamante (`issue-decompose.yml`) dichiara con QUALI label questa run è in
// volo e in quale coda va ri-accodata; il default preserva byte-per-byte il
// comportamento di `issue-fix.yml`. La SCANSIONE del beacon invece copre
// sempre entrambe le famiglie: la quota è una sola, e un beacon lasciato da
// una run di fix vale anche per una di decompose (e viceversa). Una label
// inesistente costa una `gh issue list` fallita → lista vuota (allowFail).
const LBL_ACTIVE = process.env.QUOTA_LBL_ACTIVE || LBL_FIX;
const LBL_REQUEUE = process.env.QUOTA_LBL_REQUEUE || LBL_QUEUED;
const LBL_DECOMP = 'agent:decompose';
const LBL_DECOMP_QUEUED = 'agent:decompose-queued';

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

function gh(args, { allowFail = true } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

function setOutput(blocked, resetsAt) {
  console.log(`quota_blocked=${blocked} resets_at=${resetsAt || ''}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `quota_blocked=${blocked}\nresets_at=${resetsAt || ''}\n`
    );
  }
}

/**
 * Le issue candidate a portare il beacon, deduplicate e ordinate dalla più
 * recentemente aggiornata. Pura rispetto a gh (prende le liste già lette) →
 * testabile.
 * @param {Array<Array<{number:number,updatedAt?:string}>>} lists
 * @param {{ now:number, lookbackH:number, max:number }} opts
 */
export function beaconCandidates(lists, { now, lookbackH, max }) {
  const seen = new Map();
  for (const list of lists) {
    for (const iss of list || []) {
      if (!iss || typeof iss.number !== 'number') continue;
      const t = Date.parse(iss.updatedAt || '');
      if (Number.isNaN(t)) continue;
      if (now - t > lookbackH * 3_600_000) continue;
      const prev = seen.get(iss.number);
      if (!prev || t > prev.t) seen.set(iss.number, { number: iss.number, t });
    }
  }
  return [...seen.values()].sort((a, b) => b.t - a.t).slice(0, max).map((x) => x.number);
}

function listIssues(label) {
  const raw = gh([
    'issue', 'list', ...repoArgs, '--state', 'open', '--label', label,
    '--json', 'number,updatedAt', '--limit', '100',
  ]);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function commentsOf(num) {
  const raw = gh(['issue', 'view', String(num), ...repoArgs, '--json', 'comments']);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.comments) ? parsed.comments : [];
  } catch {
    return [];
  }
}

function main() {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  const candidates = beaconCandidates(
    [listIssues(LBL_FIX), listIssues(LBL_QUEUED), listIssues(LBL_DECOMP), listIssues(LBL_DECOMP_QUEUED)],
    { now: nowMs, lookbackH: LOOKBACK_H, max: MAX_ISSUES }
  );

  if (!candidates.length) {
    console.log('Nessuna issue in lavorazione/coda toccata di recente → nessun beacon di quota. Procedo.');
    setOutput(false, '');
    return;
  }

  let resetsAt = null;
  for (const num of candidates) {
    const r = maxQuotaResetsAt(commentsOf(num));
    if (r !== null && isBackoffActive(r, nowSec)) {
      resetsAt = r;
      console.log(`Beacon di quota attivo trovato su #${num}: resetsAt=${r} (${new Date(r * 1000).toISOString()}).`);
      break;
    }
  }

  if (resetsAt === null) {
    console.log(`Nessun beacon di quota attivo fra ${candidates.length} issue ispezionate → procedo.`);
    setOutput(false, '');
    return;
  }

  const when = new Date(resetsAt * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const minutes = Math.max(1, Math.round((resetsAt - nowSec) / 60));
  console.log(`::warning::Quota Claude esaurita fino alle ${when} (~${minutes} min) — salto il fixer PRIMA di spendere la chiamata Claude.`);

  // Ri-accoda questa issue senza consumare un tentativo: la run non ha letto la
  // issue, non è un fallimento dell'agente. Label attiva → label di coda (per
  // default `agent:fix` → `agent:fix-queued`; per lo stadio di decomposizione
  // il chiamante passa la coppia `agent:decompose*`) così il drainer la
  // ripromuove appena la finestra si chiude (e nel frattempo il suo stesso
  // backoff impedisce di ripromuoverla a vuoto).
  if (ISSUE && !DRY_RUN) {
    const body = [
      '<!-- FIX_OUTCOME: rate-limited -->',
      `<!-- QUOTA_RESETS_AT: ${resetsAt} -->`,
      '',
      `⏳ **Pre-flight quota (zero-Claude)**: la quota Claude condivisa è esaurita fino alle **${when}**.`,
      'Non lancio la run Claude: morirebbe su HTTP 429 al primo turno senza leggere',
      'la issue (0 turni, $0), occupando lo slot serializzato e ritardando la coda.',
      '',
      '**Nessun tentativo consumato** (`fu-attempt` invariato): la issue torna in',
      `\`${LBL_REQUEUE}\` e riparte da sola appena la finestra si chiude.`,
    ].join('\n');
    gh(['issue', 'comment', ISSUE, ...repoArgs, '--body', body]);
    gh(['issue', 'edit', ISSUE, ...repoArgs, '--add-label', LBL_REQUEUE, '--remove-label', LBL_ACTIVE]);
  }

  setOutput(true, resetsAt);
}

// TOTAL / PROCEED-SAFE: un throw non gestito non deve mai lasciare la issue
// bloccata né congelare la coda → quota_blocked=false, exit 0 → il fixer gira
// invariato (comportamento identico a prima che questo gate esistesse).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error('Quota backoff gate error — procedo (fixer normale):', e && e.message ? e.message : e);
    setOutput(false, '');
    process.exit(0);
  }
}
