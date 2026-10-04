/**
 * monitor-issue-reconcile.mjs — la metà di CHIUSURA dei monitor che coniano
 * issue di condizione (5xx di zona, errori applicativi, CWV).
 *
 * ─── Perché esiste ──────────────────────────────────────────────────────────
 * `syncErrorIssues` (scripts/lib/error-issue-sync.mjs) conia e riconferma, ma
 * non chiude: le schede delle issue lo dichiaravano («Non esiste un closer
 * automatico»). Il criterio di chiusura è un comando che i fixer in CI non
 * possono eseguire (mancano report e credenziali), quindi ogni sweep spendeva
 * un giro per scrivere «input mancante» su issue già guarite (8773: 14
 * commenti; 7919: 28; 9583: 15 — chiuse a mano il 2026-10-03). Il passo di
 * chiusura sta qui, dentro lo stesso workflow che misura, dove dati e
 * credenziali ci sono già.
 *
 * ─── Cosa NON è un input ────────────────────────────────────────────────────
 * - La label `maybe-resolved`: 8868 e 9815 la portano e sono ancora vere. La
 *   decisione legge solo il verdetto della misura.
 * - «Assente dalle prime N»: `syncErrorIssues` lavora su
 *   `entries.slice(0, maxIssues)`. Il verdetto per una issue lo calcola il
 *   chiamante per QUELLA issue, sulla misura completa (`verdictFor`), e un
 *   titolo misurato sopra soglia in questa run è sempre `keep`.
 * - Una misura vuota per un guasto del monitor: `complete: false` → `keep`,
 *   zero scritture (non chiude e non annota).
 *
 * ─── Regola ─────────────────────────────────────────────────────────────────
 * Generale (famiglie senza un criterio sostenuto proprio, `confirmations: 2`):
 * prima misura pulita e completa → commento con il marker
 * `<!-- MONITOR_CLEAN: family=<f> at=<iso> measure=<id> -->`, nessuna
 * chiusura; misura pulita di un'ALTRA misura (altro `measure`) senza un `🔁`
 * di riconferma né un evento `reopened` dopo il marker → chiusura.
 * `confirmations: 1` è per le famiglie il cui `verdict.clean` è già un
 * criterio sostenuto (i 5xx: `checkUrlClean`, 7 snapshot completi e freschi):
 * chiusura alla prima misura pulita.
 *
 * La chiusura passa dal NUMERO riletto dell'issue DOPO un commento con
 * l'evidenza (misura, comando, finestra). Tetto di `MAX_CLOSES_PER_RUN`
 * chiusure per run; l'eccedenza è stampata e rimandata. Zero Claude: solo
 * `gh` e gli export di github-issue-creator.mjs.
 */

import { execFileSync } from 'node:child_process';
import { commentOnGithubIssue, isFailureReportingDisabled } from './github-issue-creator.mjs';

/** Le label con cui un umano o un claim tengono una issue fuori da ogni chiusura automatica. */
export const PIN_LABELS = Object.freeze([
  'keep-open',
  'agent:no-age-out',
  'pinned',
  'tracker',
  'do-not-close',
  'agent:in-progress',
]);
/** La label del proprietario che una riconferma sopra soglia smentisce. */
export const MAYBE_RESOLVED_LABEL = 'maybe-resolved';
/** Oltre questo numero di chiusure in una run il chiuditore si ferma e lo dice. */
export const MAX_CLOSES_PER_RUN = 10;
/** Lo stesso marker che `createGithubIssue` mette sui commenti di riconferma. */
export const RECURRENCE_MARKER = '🔁';

const MARKER_RE = /<!--\s*MONITOR_CLEAN:\s*family=(\S+)\s+at=(\S+)\s+measure=(\S+)\s*-->/g;

function labelNames(issue) {
  return (issue?.labels || [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter(Boolean);
}

function timeOf(item) {
  const raw = item?.createdAt ?? item?.created_at ?? '';
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : NaN;
}

/** Un id di misura sta in un attributo del marker: niente spazi né `-->`. */
export function measureId(verdict) {
  const raw = String(verdict?.measure ?? verdict?.measuredAt ?? '').trim();
  return raw.replace(/\s+/g, '_').replace(/-->/g, '') || 'unknown';
}

/** Il marker che registra una misura pulita. */
export function cleanMarker({ family, at, measure }) {
  return `<!-- MONITOR_CLEAN: family=${family} at=${at} measure=${measure} -->`;
}

/**
 * L'ultimo marker `MONITOR_CLEAN` di questa famiglia fra i commenti, con l'ora
 * del commento che lo porta. `null` se non ce n'è.
 */
export function lastCleanMarker(comments, family) {
  let found = null;
  for (const c of comments || []) {
    const body = String(c?.body ?? '');
    for (const m of body.matchAll(MARKER_RE)) {
      if (m[1] !== family) continue;
      const t = timeOf(c);
      const candidate = { family: m[1], at: m[2], measure: m[3], commentAt: Number.isFinite(t) ? t : Date.parse(m[2]) };
      if (!found || !(candidate.commentAt < found.commentAt)) found = candidate;
    }
  }
  return found;
}

/** Perché nessuna scrittura automatica può toccare questa issue, o `null`. */
export function skipReason(issue) {
  const state = String(issue?.state ?? 'OPEN').toUpperCase();
  if (state !== 'OPEN') return `issue non aperta (${state})`;
  const pins = labelNames(issue).filter((l) => PIN_LABELS.includes(l));
  if (pins.length) return `label di pin o claim: ${pins.join(', ')}`;
  return null;
}

/**
 * Decisione pura per UNA issue.
 *
 * @param {object} opts
 * @param {{number:number,title:string,state?:string,labels?:Array<string|{name:string}>}} opts.issue
 * @param {Array<{body:string,createdAt?:string,created_at?:string}>|null} [opts.comments]
 *   La storia della issue: con `confirmations > 1` va passata letta. `null` o
 *   assente = storia illeggibile → `keep`, mai «storia vuota».
 * @param {Array<{event:string,createdAt?:string,created_at?:string}>|null} [opts.events]
 * @param {{clean:boolean,complete:boolean,evidence:string,measuredAt?:string,measure?:string}|null} opts.verdict
 * @param {string} opts.family
 * @param {number} [opts.confirmations]  2 = regola generale; 1 = criterio già sostenuto.
 * @param {boolean} [opts.measuredNow]   il conio di questa run ha misurato il difetto sopra soglia.
 * @returns {{action:'close'|'note-first-clean'|'keep'|'skip', reason:string}}
 */
export function decideMonitorIssue({
  issue,
  comments,
  events,
  verdict,
  family,
  confirmations = 2,
  measuredNow = false,
}) {
  const skip = skipReason(issue);
  if (skip) return { action: 'skip', reason: skip };
  if (measuredNow) {
    return { action: 'keep', reason: 'misurata sopra soglia in questa run (riconferma del conio)' };
  }
  if (!verdict || verdict.complete !== true) {
    return { action: 'keep', reason: `misura incompleta, nessuna scrittura: ${verdict?.evidence || 'verdetto assente'}` };
  }
  if (verdict.clean !== true) return { action: 'keep', reason: `difetto ancora presente: ${verdict.evidence}` };
  if (confirmations <= 1) return { action: 'close', reason: `criterio soddisfatto: ${verdict.evidence}` };
  // Con due conferme la storia è parte della misura: senza commenti ed eventi
  // letti non si sa se una riconferma o una riapertura ha azzerato la prima
  // misura pulita. Illeggibile = «non so», mai lista vuota.
  if (!Array.isArray(comments) || !Array.isArray(events)) {
    return { action: 'keep', reason: 'storia della issue illeggibile — nessuna scrittura' };
  }

  const marker = lastCleanMarker(comments, family);
  if (!marker) return { action: 'note-first-clean', reason: `prima misura pulita: ${verdict.evidence}` };
  const after = (item) => Number.isFinite(timeOf(item)) && timeOf(item) > marker.commentAt;
  const recurred = comments.some((c) => after(c) && String(c?.body ?? '').includes(RECURRENCE_MARKER))
    || events.some((e) => e?.event === 'reopened' && after(e));
  if (recurred) {
    return { action: 'note-first-clean', reason: `riconferma o riapertura dopo la misura pulita del ${marker.at}: si riparte da capo` };
  }
  if (marker.measure === measureId(verdict)) {
    return { action: 'keep', reason: `stessa misura (${marker.measure}) già annotata: non è una seconda conferma` };
  }
  return { action: 'close', reason: `seconda misura pulita (${measureId(verdict)}) dopo ${marker.measure}: ${verdict.evidence}` };
}

function evidenceLines(verdict) {
  return [
    `**Misura:** ${verdict.evidence}`,
    verdict.command ? `**Comando:** \`${verdict.command}\`` : '',
    verdict.measuredAt ? `**Misurata il:** ${verdict.measuredAt}` : '',
  ].filter(Boolean);
}

/** Il commento della prima misura pulita: evidenza + marker, nessuna chiusura. */
export function firstCleanComment({ family, verdict, now }) {
  return [
    `🟢 Prima misura pulita e completa del monitor \`${family}\`. Nessuna chiusura: la chiude la prossima misura pulita di un'altra run, se nel frattempo non arriva una riconferma.`,
    '',
    ...evidenceLines(verdict),
    '',
    cleanMarker({ family, at: new Date(now).toISOString(), measure: measureId(verdict) }),
  ].join('\n');
}

/** Il commento che precede la chiusura. */
export function closeEvidenceComment({ family, verdict, reason }) {
  return [
    `✅ Criterio della scheda soddisfatto: chiusura automatica del monitor \`${family}\` (${reason}).`,
    '',
    ...evidenceLines(verdict),
    '',
    'Se il difetto torna sopra soglia, il monitor riapre questa issue con lo stesso titolo.',
  ].join('\n');
}

// ── I/O via gh ───────────────────────────────────────────────────────────────

function ghJsonLines(args) {
  let out;
  try {
    out = execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch {
    return null;
  }
  const items = [];
  for (const line of String(out ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      items.push(JSON.parse(t));
    } catch {
      return null;
    }
  }
  return items;
}

/**
 * L'I/O di default. Lettura REST (`gh api`, nessun indice di ricerca: vede una
 * issue nell'istante in cui esiste). Ogni lettura fallita restituisce `null`,
 * e il chiamante la tratta come «non so»: nessuna scrittura.
 */
export function ghReconcileIo() {
  const base = 'repos/{owner}/{repo}/issues';
  const readIssue = (number) => {
    const items = ghJsonLines([
      'api', `${base}/${number}`,
      '--jq', '{number, title, state: (.state | ascii_upcase), labels: [.labels[].name]}',
    ]);
    return items && items[0] ? items[0] : null;
  };
  return {
    listOpenIssues({ label }) {
      const items = ghJsonLines([
        'api', '--paginate',
        `${base}?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
        '--jq', '.[] | select(.pull_request == null) | {number, title, state: (.state | ascii_upcase), body, labels: [.labels[].name]}',
      ]);
      return items;
    },
    readIssue,
    listComments(number) {
      return ghJsonLines([
        'api', '--paginate', `${base}/${number}/comments?per_page=100`,
        '--jq', '.[] | {body, created_at}',
      ]);
    },
    listEvents(number) {
      return ghJsonLines([
        'api', '--paginate', `${base}/${number}/events?per_page=100`,
        '--jq', '.[] | select(.event == "reopened") | {event, created_at}',
      ]);
    },
    comment(number, body) {
      return commentOnGithubIssue(number, body);
    },
    close(number) {
      if (isFailureReportingDisabled()) {
        console.log('[monitor-reconcile] ENABLE_FAILURE_REPORT=false, skipping close');
        return null;
      }
      const issueNumber = Number(number);
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;
      try {
        execFileSync('gh', [
          'issue', 'close', String(issueNumber), '--reason', 'completed',
          ...(process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : []),
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      } catch {
        return { number: issueNumber, persisted: false };
      }
      const after = readIssue(issueNumber);
      return {
        number: issueNumber,
        persisted: String(after?.state || '').toUpperCase() === 'CLOSED',
      };
    },
    removeLabel(number, label) {
      if (isFailureReportingDisabled()) {
        console.log('[monitor-reconcile] ENABLE_FAILURE_REPORT=false, skipping label removal');
        return false;
      }
      try {
        execFileSync('gh', [
          'issue', 'edit', String(number), '--remove-label', label,
          ...(process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : []),
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * La fase «riconcilia»: elenca le issue APERTE della famiglia e applica
 * `decideMonitorIssue` a ciascuna.
 *
 * @param {object} opts
 * @param {string} opts.family           id stabile della famiglia (va nel marker).
 * @param {string[]} opts.labels         la prima è la label di famiglia usata per l'elenco.
 * @param {string} opts.titlePrefix      solo i titoli con questo prefisso sono della famiglia.
 * @param {(issue:object)=>object|Promise<object>} opts.verdictFor
 * @param {number} [opts.confirmations]
 * @param {Set<string>} [opts.measuredTitles]    titoli misurati sopra soglia in questa run (lista COMPLETA).
 * @param {Set<string>} [opts.reconfirmedTitles] titoli che il conio ha appena riconfermato.
 * @param {boolean} [opts.dryRun]
 * @param {number} [opts.maxCloses]
 * @param {string} [opts.workflow]
 * @param {string} [opts.runUrl]
 * @param {Date|number} [opts.now]
 * @param {object} [opts.io]             vedi `ghReconcileIo`.
 * @param {(line:string)=>void} [opts.log]
 */
export async function reconcileMonitorIssues({
  family,
  labels = [],
  titlePrefix = '',
  verdictFor,
  confirmations = 2,
  measuredTitles = new Set(),
  reconfirmedTitles = new Set(),
  dryRun = false,
  maxCloses = MAX_CLOSES_PER_RUN,
  workflow,
  runUrl,
  now = new Date(),
  io = ghReconcileIo(),
  log = (line) => console.log(line),
}) {
  const tag = `[monitor-reconcile:${family}]`;
  const out = { decisions: [], closed: [], noted: [], labelRemoved: [], excess: [], failed: [] };
  const label = labels[0];
  if (!family || !label || typeof verdictFor !== 'function') {
    log(`${tag} configurazione incompleta (family/label/verdictFor) — nessuna riconciliazione`);
    return out;
  }
  const listed = await io.listOpenIssues({ label });
  if (!Array.isArray(listed)) {
    log(`${tag} elenco delle issue aperte illeggibile — nessuna scrittura`);
    return out;
  }
  const issues = listed
    .filter((i) => String(i?.title ?? '').startsWith(titlePrefix))
    .sort((a, b) => Number(a.number) - Number(b.number));
  // Con due gemelle aperte dallo stesso titolo — stato noto,
  // `formatOpenTwinNote` le lascia aperte apposta — la decisione resta ambigua
  // per la riconciliazione della famiglia. Nessuna scrittura su un titolo
  // ambiguo; per i titoli unici la chiusura usa comunque il numero riletto.
  const titleCount = new Map();
  for (const i of issues) titleCount.set(String(i.title), (titleCount.get(String(i.title)) || 0) + 1);

  // Il tetto conta le chiusure DECISE, non quelle riuscite: in dry-run nessuna
  // riesce, e l'eccedenza deve comparire lo stesso.
  let closing = 0;
  for (const issue of issues) {
    const title = String(issue.title);
    if (reconfirmedTitles.has(title) && labelNames(issue).includes(MAYBE_RESOLVED_LABEL)) {
      const pinned = skipReason(issue);
      if (pinned) {
        log(`${tag} #${issue.number}: \`${MAYBE_RESOLVED_LABEL}\` lasciata (${pinned})`);
      } else if (dryRun) {
        log(`${tag} [dry-run] #${issue.number}: toglierei \`${MAYBE_RESOLVED_LABEL}\` (riconfermata sopra soglia)`);
      } else if (await io.removeLabel(issue.number, MAYBE_RESOLVED_LABEL)) {
        out.labelRemoved.push(issue.number);
        log(`${tag} #${issue.number}: tolta \`${MAYBE_RESOLVED_LABEL}\` — la misura sopra soglia la smentisce`);
      }
    }

    if (titleCount.get(title) > 1) {
      const decision = { action: 'keep', reason: `gemelle aperte con lo stesso titolo (${titleCount.get(title)}): chiusura per titolo ambigua — nessuna scrittura` };
      out.decisions.push({ number: issue.number, title, ...decision });
      log(`${tag}${dryRun ? ' [dry-run]' : ''} #${issue.number} keep — ${decision.reason}`);
      continue;
    }

    const measuredNow = measuredTitles.has(title);
    let verdict = null;
    if (!measuredNow) {
      try {
        verdict = await verdictFor(issue);
      } catch (err) {
        verdict = { clean: false, complete: false, evidence: `verdetto non calcolabile: ${err?.message || err}` };
      }
    }
    let comments = [];
    let events = [];
    if (verdict?.complete === true && verdict?.clean === true && confirmations > 1) {
      comments = await io.listComments(issue.number);
      events = await io.listEvents(issue.number);
      if (!Array.isArray(comments) || !Array.isArray(events)) {
        const decision = { action: 'keep', reason: 'storia della issue illeggibile — nessuna scrittura' };
        out.decisions.push({ number: issue.number, title, ...decision });
        log(`${tag} #${issue.number} keep — ${decision.reason}`);
        continue;
      }
    }
    let decision = decideMonitorIssue({ issue, comments, events, verdict, family, confirmations, measuredNow });

    if (decision.action === 'close') {
      if (closing >= maxCloses) {
        out.excess.push(issue.number);
        decision = { action: 'keep', reason: `chiudibile, oltre il tetto di ${maxCloses} chiusure per run: rimandata alla prossima` };
      } else {
        closing += 1;
      }
    }
    out.decisions.push({ number: issue.number, title, ...decision });
    log(`${tag}${dryRun ? ' [dry-run]' : ''} #${issue.number} ${decision.action} — ${decision.reason}`);
    if (dryRun || (decision.action !== 'close' && decision.action !== 'note-first-clean')) continue;

    // Rilettura subito prima di scrivere: un claim o un pin arrivato durante la
    // run, o una chiusura a mano, vincono sul verdetto calcolato prima.
    const fresh = await io.readIssue(issue.number);
    const freshSkip = fresh ? skipReason(fresh) : 'issue illeggibile';
    if (freshSkip) {
      log(`${tag} #${issue.number}: stato cambiato prima della scrittura (${freshSkip}) — nessuna scrittura`);
      continue;
    }
    const freshNumber = Number(fresh.number);
    if (!Number.isSafeInteger(freshNumber) || freshNumber !== Number(issue.number)) {
      out.failed.push(issue.number);
      log(`${tag} #${issue.number}: rilettura incoerente prima della scrittura — nessuna scrittura`);
      continue;
    }

    if (decision.action === 'note-first-clean') {
      if (await io.comment(freshNumber, firstCleanComment({ family, verdict, now }))) out.noted.push(issue.number);
      continue;
    }
    if (!(await io.comment(freshNumber, closeEvidenceComment({ family, verdict, reason: decision.reason })))) {
      out.failed.push(issue.number);
      log(`${tag} #${issue.number}: commento di evidenza non scritto — chiusura saltata`);
      continue;
    }
    try {
      const res = await io.close(freshNumber, { workflow, runUrl });
      if (res && res.persisted !== false && Number(res.number) === freshNumber) {
        out.closed.push(issue.number);
      } else if (res && res.persisted !== false) {
        out.failed.push(issue.number);
        log(`${tag} #${issue.number}: la chiusura ha colpito #${res.number}, non la issue decisa — da verificare a mano`);
      } else {
        out.failed.push(issue.number);
      }
    } catch (err) {
      out.failed.push(issue.number);
      log(`${tag} #${issue.number}: chiusura rifiutata — ${err?.message || err}`);
    }
  }
  if (out.excess.length) {
    log(`${tag} eccedenza: ${out.excess.length} issue chiudibili oltre il tetto di ${maxCloses} (${out.excess.map((n) => `#${n}`).join(', ')}) — alla prossima run`);
  }
  return out;
}
