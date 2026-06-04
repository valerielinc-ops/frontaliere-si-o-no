/**
 * classify-issue.mjs — Classificazione deterministica delle issue per issue-triage.yml.
 *
 * Estratto dallo YAML (era bash inline) per essere testabile in CI e portabile
 * (regex JS, non grep GNU `\b`; label come array, non stringa comma-joined →
 * niente bug se un nome label contiene una virgola).
 *
 * Categorie (vedi ISSUES.md → "Categorie"). Ordine = priorità conservativa:
 * revenue/tracker per primi (non devono MAI ricevere agent:fix).
 *
 * autofix = true SOLO per `crawler` e `follow-up` (fix-path deterministico /
 * micro-task). validation-failure NO (transiente non decidibile); revenue/
 * tracker/other NO (giudizio umano / non riconosciuta).
 *
 * route — COME applicare il fix (2026-06-04, anti-starvation):
 *   'fix'   → agent:fix immediato (crawler: production-critical, non è il
 *             treadmill source).
 *   'queue' → agent:fix-queued (follow-up): NON parte subito. `followup-drainer`
 *             lo promuove a agent:fix UNO alla volta, solo quando lo slot
 *             issue-fix è libero → mai cancellato-in-coda. Fix della starvation
 *             osservata 2026-06-04 (slot concurrency globale + cancel:false →
 *             60% fix-run follow-up cancellate-in-coda, ~20 issue stuck).
 *   'none'  → nessun routing (umano).
 * fuPrio — ordine di drenaggio per i follow-up: 'high' (funnel monetization/seo
 *   o priority:high) drenato prima di 'low'. null per i non-follow-up.
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
  let autofix = false;
  let route = 'none';
  let fuPrio = null;

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
    autofix = true;
    route = 'fix'; // immediato: production-critical, non è il treadmill source
  } else if (t(/^follow-up\(#/i) || has('follow-up')) {
    category = 'follow-up';
    autofix = true;
    route = 'queue'; // drenato 1-alla-volta dal followup-drainer (anti-starvation)
    fuPrio =
      has('funnel-monetization') || has('funnel-seo') || has('priority:high')
        ? 'high'
        : 'low';
  } else if (t(/Validation Failure/i) || (has('bug') && has('priority:urgent'))) {
    // NO autofix: transiente-vs-persistente non decidibile deterministicamente.
    category = 'validation-failure';
  }

  return { category, autofix, route, fuPrio };
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
