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
 * category-based rimosse — vedi AGENTS.md → "Issue automation"). Il fixer ha
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

  const autofix = true;
  const route = category === 'crawler' ? 'fix' : 'queue'; // crawler: immediato; resto: coda anti-starvation
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

/** Label che marca il padre di una decomposizione (vedi `issue-decompose.yml`). */
export const LBL_DECOMPOSED = 'decomposed:1';

/**
 * Il padre di una decomposizione NON è instradabile al fixer (#6504).
 *
 * Vive qui, accanto a `classifyIssue`, perché è una decisione di ROUTING e i due
 * consumatori — `followup-drainer.mjs` (rescue + DRAIN) e `triage-sweep.mjs`
 * (triaged-but-not-routed) — devono applicare la stessa regola: duplicarla a mano
 * è esattamente il drift che la single-source-of-truth del routing esiste per
 * impedire. Il lavoro del padre sta nelle sub-issue figlie e lo chiude il
 * PARENT-CLOSE del drainer quando sono tutte chiuse; promuoverlo brucia un run
 * Claude che non può che riscoprire l'overlap con le figlie.
 * @param {{labels?: Array<{name:string}>}} iss
 */
export function isDecomposedParent(iss) {
  return (iss?.labels || []).map((l) => l?.name).includes(LBL_DECOMPOSED);
}

// CLI mode
if (process.argv[1] && process.argv[1].endsWith('classify-issue.mjs')) {
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
