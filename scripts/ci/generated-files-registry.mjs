import {
  CORPUS_OBSERVER_FILES,
  CRAWLER_WORKFLOW_FILES,
} from './prepare-crawler-workflow-corpus-sync.mjs';

const crawlerGroupFiles = CRAWLER_WORKFLOW_FILES.filter((file) => (
  /^crawler-group-\d{2}\.yml$/u.test(file)
));

const exactPathPattern = (paths) => new RegExp(
  `^(?:${paths.map((path) => path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})$`,
  'u',
);

const crawlerGeneratedPaths = [
  'data/crawler-group-assignments.json',
  'scripts/ci/crawler-generation-roster.json',
  ...crawlerGroupFiles.map((file) => `.github/workflows/${file}`),
  ...crawlerGroupFiles.map((file) => `.github/workflows/${file.replace(/\.yml$/u, '-logic.yml')}`),
  ...CRAWLER_WORKFLOW_FILES.map((file) => `.github/corpus-workflows/${file}`),
  ...CORPUS_OBSERVER_FILES.map(({ source }) => `.github/corpus-workflows/${source}`),
  '.github/corpus-workflows/contract.json',
];

const crawlerGeneratedOutputDirectories = [...new Set(
  crawlerGeneratedPaths
    .filter((path) => path.startsWith('.github/'))
    .map((path) => `/${path.split('/').slice(0, 2).join('/')}/`),
)];

const crawlerGeneratorWorktreePaths = [
  '/data/canton-municipalities.json',
  '/data/swiss-locality-postal-codes.json',
  '/data/crawler-manifest.json',
  '/data/crawler-workflow-duration-baseline.json',
  '/data/crawler-group-assignments.json',
  '/data/crawler-quarantine.json',
  ...crawlerGeneratedOutputDirectories,
];

/**
 * File scritti a mano che il generatore LEGGE: se uno di questi e' in conflitto,
 * rigenerare prima di averlo risolto produrrebbe artefatti calcolati su un input
 * con i marcatori di conflitto (o sul lato sbagliato). Il generatore, i moduli
 * che importa dal suo albero (`scripts/lib/crawler-*`) e i dati di input
 * dichiarati in `worktreePaths` (esclusi gli output). Un elenco conservativo:
 * un falso positivo costa solo un hand-off manuale, un falso negativo una
 * rigenerazione sbagliata.
 */
const crawlerGeneratorInputPatterns = [
  exactPathPattern([
    'scripts/generate-crawler-group-workflows.mjs',
    'scripts/crawler-group-generation-finalizer.mjs',
    'scripts/ci/prepare-crawler-workflow-corpus-sync.mjs',
    'scripts/ci/apply-checkout-profiles.mjs',
    'scripts/ci/checkout-buckets.json',
    'scripts/ci/translate-watchdog-pin.mjs',
    'scripts/lib/atomic-write-json.mjs',
    'scripts/lib/atomic-shard-write.mjs',
    'scripts/lib/global-data-pipeline-lease.mjs',
    'data/canton-municipalities.json',
    'data/swiss-locality-postal-codes.json',
    'data/crawler-manifest.json',
    'data/crawler-workflow-duration-baseline.json',
    'data/crawler-quarantine.json',
    'package.json',
  ]),
  /^scripts\/(?:ci\/)?lib\/crawler-[^/]+$/u,
];

const crawlerGeneratorDisplay = 'CRAWLER_SOURCE_REF=main CRAWLER_SOURCE_COMMIT="$(git merge-base origin/main HEAD)" node scripts/generate-crawler-group-workflows.mjs';

const crawlerGenerator = Object.freeze({
  id: 'crawler-group-workflows',
  argv: Object.freeze(['node', 'scripts/generate-crawler-group-workflows.mjs']),
  display: crawlerGeneratorDisplay,
  env: Object.freeze({ CRAWLER_SOURCE_REF: 'main' }),
});

const crawlerVerifier = Object.freeze({
  id: 'crawler-group-workflows-check',
  argv: Object.freeze(['node', 'scripts/generate-crawler-group-workflows.mjs', '--check']),
  display: `${crawlerGeneratorDisplay} --check`,
  env: Object.freeze({ CRAWLER_SOURCE_REF: 'main' }),
});

/**
 * Fonte unica per i conflitti che possono essere risolti rigenerando artefatti.
 * I path sono derivati dal registro crawler gia' usato dal trasporto; qui si
 * aggiungono soltanto gli output locali del medesimo generatore e i comandi.
 */
export const GENERATED_FILE_REGISTRY = Object.freeze([
  Object.freeze({
    id: crawlerGenerator.id,
    pathPatterns: Object.freeze([exactPathPattern(crawlerGeneratedPaths)]),
    inputPatterns: Object.freeze(crawlerGeneratorInputPatterns),
    worktreePaths: Object.freeze(crawlerGeneratorWorktreePaths),
    generator: crawlerGenerator,
    verifier: crawlerVerifier,
  }),
]);

export function generatedConflictPlan(paths, registry = GENERATED_FILE_REGISTRY) {
  const uniquePaths = [...new Set(paths)].filter((path) => typeof path === 'string' && path.length > 0);
  const unregistered = uniquePaths.filter((path) => (
    !registry.some((rule) => rule.pathPatterns.some((pattern) => pattern.test(path)))
  ));
  const rules = [];
  for (const path of uniquePaths) {
    const rule = registry.find((candidate) => (
      candidate.pathPatterns.some((pattern) => pattern.test(path))
    ));
    if (rule && !rules.includes(rule)) rules.push(rule);
  }
  return {
    eligible: uniquePaths.length > 0 && unregistered.length === 0,
    paths: uniquePaths,
    unregistered,
    rules,
  };
}

export function generatedConflictWorktreePaths(plan) {
  return [...new Set(
    (plan?.rules || [])
      .flatMap((rule) => (Array.isArray(rule.worktreePaths) ? rule.worktreePaths : []))
      .filter((path) => typeof path === 'string' && path.length > 0),
  )];
}

/**
 * Divide i path in conflitto in «da rigenerare» (nel registro) e «da risolvere»
 * (scritti a mano). `inputConflicts` sono i path da risolvere che sono INPUT di
 * un generatore coinvolto: in quel caso la rigenerazione va dopo la
 * risoluzione, mai prima. Pura.
 */
export function generatedConflictPartition(paths, registry = GENERATED_FILE_REGISTRY) {
  const uniquePaths = [...new Set(paths)].filter((path) => typeof path === 'string' && path.length > 0);
  const generated = [];
  const manual = [];
  const rules = [];
  for (const path of uniquePaths) {
    const plan = generatedConflictPlan([path], registry);
    if (plan.eligible) {
      generated.push(path);
      for (const rule of plan.rules) if (!rules.includes(rule)) rules.push(rule);
    } else {
      manual.push(path);
    }
  }
  const inputConflicts = rules.length === 0
    ? []
    : manual.filter((path) => rules.some((rule) => (
      (rule.inputPatterns || []).some((pattern) => pattern.test(path))
    )));
  return { generated, manual, rules, inputConflicts };
}
