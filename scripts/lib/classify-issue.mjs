/**
 * classify-issue.mjs — Classificazione deterministica delle issue per issue-triage.yml.
 *
 * Estratto dallo YAML (era bash inline) per essere testabile in CI e portabile
 * (regex JS, non grep GNU `\b`; label come array, non stringa comma-joined →
 * niente bug se un nome label contiene una virgola).
 *
 * Categorie (vedi ISSUES.md → "Categorie"). Ordine = priorità conservativa:
 * revenue/tracker per primi (guardia anti-collisione nomi azienda: es. "RPM
 * Software AG" deve restare `revenue`, non `crawler`, pur matchando la regex
 * crawler — vedi tests/classify-issue.test.ts).
 *
 * autofix = true per OGNI categoria (2026-07-05, owner decision: guardrail
 * category-based rimosse — vedi AGENTS.md → "Issue automation"). L'unica
 * eccezione non è una categoria ma un PIN esplicito sulla singola issue
 * (`FIXER_EXEMPT_LABELS`, sotto): un tracker su causa esterna. Il fixer ha
 * comunque le sue safety-valve generiche (root-cause non determinabile,
 * capability-guard workflows/secrets, ecc. — ISSUES.md → "Abort senza PR"):
 * quelle restano, non sono guardrail di categoria.
 *
 * route — COME applicare il fix (2026-06-04, anti-starvation):
 *   'fix'   → agent:fix immediato (crawler: production-critical, basso volume,
 *             route diretto provato sicuro da mesi — resta l'UNICA eccezione).
 *   'queue' → agent:fix-queued (ogni altra categoria): NON parte subito.
 *             `followup-drainer` lo promuove a agent:fix UNO alla volta, solo
 *             quando lo slot issue-fix è libero → mai cancellato-in-coda. Fix
 *             della starvation osservata 2026-06-04 (slot concurrency globale
 *             + cancel:false → 60% fix-run cancellate-in-coda, ~20 issue
 *             stuck) — estendere l'auto-fix a tutte le categorie senza tenere
 *             questo meccanismo reintrodurrebbe la stessa starvation.
 * fuPrio — ordine di drenaggio della coda: 'high' (funnel monetization/seo,
 *   priority:high/urgent, o categoria revenue) drenato prima di 'low'. Sempre
 *   calcolato per qualunque categoria in coda (non solo follow-up).
 *
 * Uso modulo:
 *   import { classifyIssue } from './classify-issue.mjs';
 *   const { category, autofix, route, fuPrio } = classifyIssue(title, labels);
 *
 * Uso CLI (dal workflow):
 *   node scripts/lib/classify-issue.mjs "<title>" '<labels-json-array>'
 *   → stdout JSON: {"category":"crawler","autofix":true,"route":"fix","fuPrio":null}
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Label che PINNANO una issue fuori dal ciclo di fix automatico.
 *
 * Sono tracker su una causa che vive FUORI dal repository: nessun turn-budget
 * le chiude, perché l'input che manca non è codice. Mandarci il fixer costa un
 * run Max (~1M token) per ri-scoprire ogni volta la stessa cosa, e rischia di
 * chiudere ciò che deve restare aperto — l'opposto del compito del tracker.
 *
 *   `keep-open`         pin esplicito «tracker su causa esterna» (la stessa
 *                       label che `reconcile-followups.mjs` già onora come veto
 *                       all'auto-close). Fino a ora vietava la CHIUSURA ma non
 *                       la PROMOZIONE: #7648 nasce dichiarando nel body «senza
 *                       agent:fix-queued/agent:fix», e ha comunque attraversato
 *                       triage → coda → `agent:fix` → un run del fixer.
 *   `agent:no-age-out`  tracker/issue-contatore permanente (#5615). Identica
 *                       asimmetria, già diagnosticata e chiusa a metà da #5544:
 *                       l'esclusione dalla promozione esisteva solo nel pool del
 *                       PARKED-RETRY di `followup-drainer.mjs`, cioè per chi era
 *                       già stato parcheggiato — non alla porta d'ingresso.
 *
 * Le altre tre label del veto all'auto-close di `reconcile-followups.mjs`
 * (`pinned`, `do-not-close`, `revenue`/`tracker`) NON sono qui, e la differenza
 * è voluta: le prime due dicono «non chiudere», che non implica «non riparare»;
 * `revenue`/`tracker` sono instradate al fixer per decisione esplicita del
 * proprietario del 2026-07-05 («Rimuovi tutte le guardie»), e riesumarle qui
 * sarebbe reintrodurre di soppiatto una guardrail di categoria.
 */
export const FIXER_EXEMPT_LABELS = ['keep-open', 'agent:no-age-out'];

/**
 * Questa issue è pinnata fuori dal ciclo di fix automatico? Pura → testabile.
 * @param {Array<string|{name:string}>} labels
 */
export function isFixerExempt(labels = []) {
  const set = new Set((labels || []).map((l) => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase()));
  return FIXER_EXEMPT_LABELS.some((l) => set.has(l));
}

export function classifyIssue(title = '', labels = []) {
  const set = new Set((labels || []).map((s) => String(s).toLowerCase()));
  const has = (name) => set.has(String(name).toLowerCase());
  const t = (re) => re.test(title || '');

  let category = 'other';

  if (has('revenue') || has('rpm-canary') || t(/RPM canary|\bRPM\b/i)) {
    category = 'revenue';
  } else if (t(/master tracker|recovery/i)) {
    category = 'tracker';
  } else if (
    t(/Crawler Failure|crawler-health|\[parser-health\]/i) ||
    has('parser-broken') ||
    (has('priority:high') && t(/crawler|parser/i))
  ) {
    // parser-broken: issue `[parser-health]` (assemble-jobs-dataset.mjs) =
    // parser-regen, natura crawler, funnel-rilevante (boilerplate → thin).
    category = 'crawler';
  } else if (t(/^follow-up\(#/i) || has('follow-up')) {
    category = 'follow-up';
  } else if (t(/Validation Failure/i) || (has('bug') && has('priority:urgent'))) {
    category = 'validation-failure';
  }

  // Pin fuori dal ciclo (vedi `FIXER_EXEMPT_LABELS`): la categoria resta quella
  // che è — serve ancora a chi legge e ai monitor — ma non c'è routing. Il
  // ramo `route === 'none' || autofix !== true` esiste già, e intatto, in
  // `issue-triage.yml`, in entrambi i passaggi di `triage-sweep.mjs` e nel
  // drainer: era stato lasciato «come guard contro un futuro classifier che
  // reintroduca una categoria human-only». Questo è quel caso.
  const exempt = isFixerExempt(labels);
  const autofix = !exempt;
  const route = exempt ? 'none' : category === 'crawler' ? 'fix' : 'queue'; // crawler: immediato; resto: coda anti-starvation
  const fuPrio =
    route === 'queue'
      ? has('funnel-monetization') ||
        has('funnel-seo') ||
        has('priority:high') ||
        has('priority:urgent') ||
        category === 'revenue'
        ? 'high'
        : 'low'
      : null;

  return { category, autofix, route, fuPrio };
}

// CLI mode
// Entrypoint canonico, non suffisso del path (#7292): `endsWith` diceva true
// per QUALUNQUE entrypoint il cui `argv[1]` finisse con questo nome di file;
// `realpathSync` copre l'invocazione via symlink, dove `argv[1]` e' il link.
const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();
if (isDirectRun) {
  const title = process.argv[2] || '';
  let labels = [];
  try {
    labels = JSON.parse(process.argv[3] || '[]');
    if (!Array.isArray(labels)) labels = [];
  } catch {
    labels = [];
  }
  process.stdout.write(JSON.stringify(classifyIssue(title, labels)));
}
