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
