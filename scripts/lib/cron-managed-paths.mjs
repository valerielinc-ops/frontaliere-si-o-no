// Percorsi tracciati che scrivono i cron su `main`, non le persone.
//
// Sorgente UNICA della lista: la consumano `scripts/dev/local-ignore-cron.sh`
// (che ci flippa `--skip-worktree` per nascondere il rumore da `git status`) e
// `scripts/prune-merged-worktrees.mjs` (che non deve considerare "lavoro" un
// worktree sporco solo di output di cron). Duplicarla in due file la farebbe
// derivare: un cron nuovo aggiunto in un posto solo produce un difetto
// silenzioso da una parte e non dall'altra.
//
// Un file elencato qui, se compare modificato in locale, NON e' lavoro: e'
// output di un workflow, o di uno script eseguito qui. Vedi AGENTS.md,
// `## Build And Test`.
export const CRON_MANAGED_GLOBS = Object.freeze([
  // Job crawlers — the noisiest set
  'data/all-known-job-slugs/*',
  'data/known-company-slugs.json',
  'data/jobs/by-crawler/*',
  'data/jobs-crawler-adapters/adapters/*',
  'data/jobs-crawler-summaries/by-crawler/*',
  'data/jobs-crawler-parser-proposals.json',
  'data/jobs-keys-snapshot.json',
  'data/jobs-stats-history.json',
  'data/jobs-snapshots-history/*',
  'public/data/expired-jobs.json',

  // SEO / GSC pipelines
  'data/gsc-orphan-queries-clusters.json',
  'data/seo-404-compat/*',
  'data/seo-serp-autopilot-last-run.json',
  'data/seo-serp-experiment-history.json',
  // Registro delle famiglie CTR auto-classificate (monitor-seo-ctr-by-template.yml, #7174).
  'scripts/lib/seo-ctr-auto-families.json',
  'data/seo-snapshots/*',
  'data/inspection-state.json',

  // Daily refresh feeds
  'data/fuel-prices.json',
  'public/data/fuel-prices.json',
  'data/health-premiums.json',
  'public/data/health-premiums.json',
  'data/health-premiums/*',
  'public/data/health-premiums/*',
  'data/border-wait-current.json',
  'data/border-wait-history/*',
  'public/data/switzerland-unemployment-rate.json',

  // Weekly aggregates
  'data/weekly-employers-delta.json',
  'data/company-logos-broken.json',

  // Report di qualita' dei parser, riscritto a ogni run del crawler.
  'data/parser-quality-report.json',

  // Rapporti del prospector, riscritti dalla sua pipeline.
  'data/prospector/crawlers/*',

  // FAQ batch progress
  'data/batch-faq-progress.json',
]);

// `*` nei pathspec di git attraversa gli slash (`data/seo-404-compat/*` prende
// anche le sottodirectory), quindi qui vale `.*`, non `[^/]*`.
function globToRegExp(glob) {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

const MATCHERS = CRON_MANAGED_GLOBS.map(globToRegExp);

export function isCronManagedPath(filePath) {
  const normalized = String(filePath || '').replace(/^\.\//, '');
  return MATCHERS.some((re) => re.test(normalized));
}
