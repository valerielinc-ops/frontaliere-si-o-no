#!/usr/bin/env node

/**
 * Prepara, dentro un checkout del corpus, la consegna atomica dei workflow
 * crawler generati dal sito. Non esegue git o chiamate GitHub: il workflow di
 * trasporto puo' quindi ispezionare e allowlistare il diff reale prima del push.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCrawlerGroupIds,
  deriveCrawlerGroupIdsFromContract,
} from '../lib/crawler-generation-group-ids.mjs';

export const CRAWLER_WORKFLOW_FILES = [
  ...createCrawlerGroupIds(24).map((group) => `crawler-group-${group}.yml`),
  'translate-pending.yml',
];

export function crawlerWorkflowFilesFromContract(contract) {
  return [
    ...deriveCrawlerGroupIdsFromContract(contract).map((group) => `crawler-group-${group}.yml`),
    'translate-pending.yml',
  ];
}

export const CORPUS_CONTRACT_PATH = 'generator/data/crawler-cross-repo-contract.json';
export const CORPUS_MANIFEST_PATH = 'scripts/ci/loop-sync-manifest.json';
export const CORPUS_OBSERVER_FILES = [
  {
    source: 'observers/generator/tests/crawler-cross-repo-artifacts.test.mjs',
    target: 'generator/tests/crawler-cross-repo-artifacts.test.mjs',
  },
  {
    source: 'observers/workflows/crawler-generation-observer-shadow.yml',
    target: '.github/workflows/crawler-generation-observer-shadow.yml',
  },
  {
    source: 'observers/scripts/crawler-generation-observer-selector.mjs',
    target: 'scripts/ci/crawler-generation-observer-selector.mjs',
  },
  {
    source: 'observers/scripts/lib/canonical-json-digest.mjs',
    target: 'scripts/ci/lib/canonical-json-digest.mjs',
  },
  {
    source: 'observers/scripts/lib/crawler-generation-observer-report.mjs',
    target: 'scripts/ci/lib/crawler-generation-observer-report.mjs',
  },
  {
    source: 'observers/scripts/lib/crawler-generation-group-ids.mjs',
    target: 'scripts/ci/lib/crawler-generation-group-ids.mjs',
  },
  {
    source: 'observers/scripts/lib/crawler-generation-token.mjs',
    target: 'scripts/ci/lib/crawler-generation-token.mjs',
  },
  {
    source: 'observers/scripts/lib/github-actions-read-client.mjs',
    target: 'scripts/ci/lib/github-actions-read-client.mjs',
  },
];

const CANONICAL_TRANSPORT_MANIFEST_KEYS = 'baseline,mode,path,sitePath';
const IDENTICAL_CONTRACT_WITH_REASON_KEYS = 'baseline,mode,path,reason,sitePath';
const COUPLING_SNAPSHOT_SITE_PATH =
  '.github/corpus-workflows/observers/generator/tests/crawler-cross-repo-artifacts.test.mjs';

// The corpus-side observer records this derived graph in the shared manifest.
// Keep this exception narrow: transport must remain strict for every other
// mapping so an unrelated corpus change cannot hide in the sync PR.
function hasValidCouplingSnapshot(value) {
  return Array.isArray(value) && value.every((coupling) => (
    coupling && typeof coupling === 'object' && !Array.isArray(coupling)
    && typeof coupling.path === 'string'
    && typeof coupling.mode === 'string'
    && (coupling.unreadable === undefined || typeof coupling.unreadable === 'string')
    && Object.keys(coupling).every((key) => ['path', 'mode', 'unreadable'].includes(key))
  ));
}

function hasValidTransportManifestKeys(entry) {
  const keys = Object.keys(entry).sort().join(',');
  if (keys === CANONICAL_TRANSPORT_MANIFEST_KEYS) return true;
  // The corpus can retain the explanatory reason written while this contract
  // was `adapted`, even after the entry converges to `identical`. Keep this
  // compatibility narrow: only the owned contract mapping may carry that
  // historical field; every other identical transport entry remains strict.
  if (entry.sitePath === '.github/corpus-workflows/contract.json'
      && entry.mode === 'identical'
      && keys === IDENTICAL_CONTRACT_WITH_REASON_KEYS
      && typeof entry.reason === 'string') return true;
  return entry.sitePath === COUPLING_SNAPSHOT_SITE_PATH
    && keys === 'baseline,couplingSnapshot,mode,path,sitePath'
    && hasValidCouplingSnapshot(entry.couplingSnapshot);
}

const LEGACY_OBSERVER_TARGETS = new Set(CORPUS_OBSERVER_FILES.map(({ target }) => target));

// PR #1515 registered these two transport entries as `adapted` while the
// corpus-only translation lease removal was being carried. Once the canonical
// site artifact also drops that lease, the next official sync must be able to
// converge them back to `identical` and remove the temporary reason.
const CONVERGENT_ADAPTED_TRANSPORT_SITE_PATHS = new Set([
  '.github/corpus-workflows/translate-pending.yml',
  '.github/corpus-workflows/contract.json',
]);

// A previous transport layout accidentally registered observer files below
// `.github/workflows/observers/`. Those entries are stale duplicates of the
// canonical observer destinations and may be removed during normalization;
// every other duplicate remains fail-closed.
function isLegacyObserverTransportEntry(entry, destination) {
  return LEGACY_OBSERVER_TARGETS.has(destination)
    && typeof entry?.path === 'string'
    && entry.path.startsWith('.github/workflows/observers/');
}

function isConvergentAdaptedTransportEntry(entry, sitePath) {
  return CONVERGENT_ADAPTED_TRANSPORT_SITE_PATHS.has(sitePath)
    && entry?.mode === 'adapted'
    && typeof entry?.reason === 'string'
    && Object.keys(entry).sort().join(',') === 'baseline,mode,path,reason,sitePath';
}

function sha16(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function readRequired(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`required crawler transport input missing: ${filePath}`);
  }
  return fs.readFileSync(filePath);
}

export function expectedCorpusPaths(crawlerWorkflowFiles = CRAWLER_WORKFLOW_FILES) {
  return [
    ...crawlerWorkflowFiles.map((file) => `.github/workflows/${file}`),
    ...CORPUS_OBSERVER_FILES.map((observer) => observer.target),
    CORPUS_CONTRACT_PATH,
    CORPUS_MANIFEST_PATH,
  ];
}

function expectedMappings(crawlerWorkflowFiles = CRAWLER_WORKFLOW_FILES) {
  return new Map([
    ...crawlerWorkflowFiles.map((file) => `.github/corpus-workflows/${file}`),
  ].map((sitePath) => [sitePath, `.github/workflows/${path.basename(sitePath)}`]).concat(
    CORPUS_OBSERVER_FILES.map(({ source, target }) => [
      `.github/corpus-workflows/${source}`,
      target,
    ]), [
    ['.github/corpus-workflows/contract.json', CORPUS_CONTRACT_PATH],
  ]));
}

export const PORTABLE_CORPUS_SITE_PREFIX = '.github/corpus-workflows/';

/**
 * Registro lockstep delle famiglie crawler: i sitePath che il trasporto
 * registra come voci `identical` del loop-sync manifest del corpus. E' la
 * stessa mappa che `prepareCrawlerWorkflowCorpusSync` copia e baselinea, non
 * una lista parallela da tenere allineata a mano.
 */
export function registeredCorpusSitePaths(crawlerWorkflowFiles = CRAWLER_WORKFLOW_FILES) {
  return [...expectedMappings(crawlerWorkflowFiles).keys()].sort();
}

/** Elenca ricorsivamente un albero portabile come sitePath `.github/corpus-workflows/...`. */
export function listPortableTreeSitePaths(dir) {
  const out = [];
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), childRel);
      else out.push(`${PORTABLE_CORPUS_SITE_PREFIX}${childRel}`);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * Differenza fra le famiglie emesse e il registro lockstep. `unregistered` sono
 * file emessi che il trasporto non copierebbe ne' censirebbe (il corpus li
 * scoprirebbe solo dal censimento notturno dei gemelli, #1571 corpus);
 * `unemitted` sono voci registrate senza un file emesso, che farebbero fallire
 * la consegna a meta'.
 */
export function diffEmittedFamiliesAgainstRegistry({ emittedSitePaths, registeredSitePaths } = {}) {
  if (!Array.isArray(registeredSitePaths) || registeredSitePaths.length === 0) {
    throw new Error('crawler lockstep registry missing or empty: cannot prove emitted families are registered');
  }
  if (!Array.isArray(emittedSitePaths)) {
    throw new Error('crawler lockstep check requires the emitted site paths');
  }
  const registered = new Set(registeredSitePaths);
  const emitted = new Set(emittedSitePaths);
  return {
    unregistered: [...emitted].filter((sitePath) => !registered.has(sitePath)).sort(),
    unemitted: [...registered].filter((sitePath) => !emitted.has(sitePath)).sort(),
  };
}

/** Fallisce se una famiglia emessa non ha la sua voce lockstep, o viceversa. */
export function assertEmittedFamiliesRegistered({ emittedSitePaths, registeredSitePaths, origin = 'emitted' } = {}) {
  const { unregistered, unemitted } = diffEmittedFamiliesAgainstRegistry({ emittedSitePaths, registeredSitePaths });
  if (unregistered.length === 0 && unemitted.length === 0) return;
  const lines = [
    ...unregistered.map((sitePath) => `  unregistered ${origin} family: ${sitePath}`),
    ...unemitted.map((sitePath) => `  registered but not ${origin}: ${sitePath}`),
  ];
  throw new Error(
    'crawler family lockstep violated: every file under .github/corpus-workflows/ must be a '
    + 'transport mapping (CRAWLER_WORKFLOW_FILES / CORPUS_OBSERVER_FILES / contract.json) '
    + `in scripts/ci/prepare-crawler-workflow-corpus-sync.mjs\n${lines.join('\n')}`,
  );
}

function contentForSitePath(sitePath, { contractBuffer, payloads, observerPayloads }) {
  if (sitePath.endsWith('/contract.json')) return contractBuffer;
  const observer = CORPUS_OBSERVER_FILES.find(({ source }) =>
    sitePath === `.github/corpus-workflows/${source}`);
  return observer
    ? observerPayloads.get(observer.target)
    : payloads.get(path.basename(sitePath));
}

/** Consente rispetto a main soltanto le baseline crawler owned censite sopra. */
export function assertCrawlerManifestDelta({ baseManifest, currentManifest, crawlerWorkflowFiles } = {}) {
  if (!baseManifest || !currentManifest) throw new Error('baseManifest and currentManifest are required');
  const expected = structuredClone(baseManifest);
  const discoveredWorkflowFiles = crawlerWorkflowFiles ?? [
    ...new Set([
      ...CRAWLER_WORKFLOW_FILES,
      ...(currentManifest.files ?? [])
        .map((entry) => entry.sitePath)
        .filter((sitePath) => /^\.github\/corpus-workflows\/crawler-group-\d{2}\.yml$/u.test(sitePath ?? ''))
        .map((sitePath) => path.basename(sitePath)),
    ]),
  ];
  const mappings = expectedMappings(discoveredWorkflowFiles);
  const currentOwned = new Map();
  for (const entry of currentManifest.files ?? []) {
    if (!mappings.has(entry.sitePath)) continue;
    if (currentOwned.has(entry.sitePath)) throw new Error(`duplicate owned crawler manifest entry: ${entry.sitePath}`);
    currentOwned.set(entry.sitePath, entry);
  }
  expected.files = (expected.files ?? []).filter((entry) => (
    !isLegacyObserverTransportEntry(entry, mappings.get(entry.sitePath))
  ));
  for (const [sitePath, destination] of mappings) {
    const current = currentOwned.get(sitePath);
    if (!current || current.path !== destination || current.mode !== 'identical' ||
        !hasValidTransportManifestKeys(current)) {
      throw new Error(`owned crawler manifest entry missing or malformed: ${sitePath}`);
    }
    const baseIndex = (expected.files ?? []).findIndex((entry) => entry.sitePath === sitePath);
    if (baseIndex >= 0) {
      if (isConvergentAdaptedTransportEntry(expected.files[baseIndex], sitePath)) {
        expected.files[baseIndex] = structuredClone(current);
      } else {
        expected.files[baseIndex].baseline = structuredClone(current.baseline);
        if (Object.hasOwn(current, 'couplingSnapshot')) {
          expected.files[baseIndex].couplingSnapshot = structuredClone(current.couplingSnapshot);
        }
      }
    } else {
      expected.files.push(structuredClone(current));
    }
  }
  if (JSON.stringify(currentManifest) !== JSON.stringify(expected)) {
    throw new Error('crawler transport changed loop-sync manifest outside its owned baselines');
  }
}

export function prepareCrawlerWorkflowCorpusSync({ sourceDir, corpusRoot, alignedAt } = {}) {
  if (!sourceDir || !corpusRoot) throw new Error('sourceDir and corpusRoot are required');
  const contractBuffer = readRequired(path.join(sourceDir, 'contract.json'));
  const contract = JSON.parse(contractBuffer.toString('utf8'));
  const crawlerWorkflowFiles = crawlerWorkflowFilesFromContract(contract);
  const contractFiles = (contract.artifacts ?? []).map((artifact) => artifact.file).sort();
  const expectedFiles = [...crawlerWorkflowFiles].sort();
  if (JSON.stringify(contractFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('crawler transport contract must name exactly the generated executable artifacts');
  }
  if (JSON.stringify(contract.observers ?? []) !== JSON.stringify(
    CORPUS_OBSERVER_FILES.map(({ source, target }) => ({ source, target, sha256: contract.observers?.find((observer) => observer.source === source)?.sha256 })),
  )) {
    throw new Error('crawler transport contract must name exactly the dedicated observers');
  }

  // Leggi e valida tutto PRIMA di scrivere. Un export troncato non puo'
  // cancellare o aggiornare parzialmente il checkout di destinazione.
  const payloads = new Map(crawlerWorkflowFiles.map((file) => [
    file,
    readRequired(path.join(sourceDir, file)),
  ]));
  for (const artifact of contract.artifacts) {
    const content = payloads.get(artifact.file);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    if (artifact.artifactSha256 !== hash) {
      throw new Error(`${artifact.file}: content does not match transport contract`);
    }
  }
  const observerPayloads = new Map(CORPUS_OBSERVER_FILES.map((observer) => [
    observer.target,
    readRequired(path.join(sourceDir, observer.source)),
  ]));
  for (const observer of contract.observers) {
    const content = observerPayloads.get(observer.target);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    if (observer.sha256 !== hash) {
      throw new Error(`${observer.source}: content does not match transport contract`);
    }
  }
  // Un file dell'export che nessuna mappa registra non verrebbe ne' copiato ne'
  // baselineato: la consegna resterebbe verde lasciando la famiglia fuori dal
  // lockstep. Fallisci prima di scrivere nel checkout del corpus.
  assertEmittedFamiliesRegistered({
    emittedSitePaths: listPortableTreeSitePaths(sourceDir),
    registeredSitePaths: registeredCorpusSitePaths(crawlerWorkflowFiles),
    origin: 'exported',
  });

  const manifestPath = path.join(corpusRoot, CORPUS_MANIFEST_PATH);
  const manifest = JSON.parse(readRequired(manifestPath).toString('utf8'));
  const mappings = expectedMappings(crawlerWorkflowFiles);
  const observed = new Set();
  const date = alignedAt ?? new Date().toISOString().slice(0, 10);
  const normalizedFiles = [];
  for (const entry of manifest.files ?? []) {
    const destination = mappings.get(entry.sitePath);
    if (!destination) {
      normalizedFiles.push(entry);
      continue;
    }
    const convergentAdapted = isConvergentAdaptedTransportEntry(entry, entry.sitePath);
    const canonicalIdentical = entry.mode === 'identical' && hasValidTransportManifestKeys(entry);
    if (isLegacyObserverTransportEntry(entry, destination)) continue;
    if (entry.path !== destination || (!canonicalIdentical && !convergentAdapted) ||
        observed.has(entry.sitePath)) {
      throw new Error(`invalid or duplicate crawler transport mapping: ${entry.sitePath}`);
    }
    if (convergentAdapted) {
      entry.mode = 'identical';
      delete entry.reason;
    }
    observed.add(entry.sitePath);
    normalizedFiles.push(entry);
    const content = contentForSitePath(entry.sitePath, { contractBuffer, payloads, observerPayloads });
    const hash = sha16(content);
    const baselineKeys = Object.keys(entry.baseline ?? {}).sort();
    const baselineIsCanonical = baselineKeys.join(',') === 'alignedAt,corpus,site' &&
      /^\d{4}-\d{2}-\d{2}$/.test(entry.baseline.alignedAt ?? '');
    if (entry.baseline?.site !== hash || entry.baseline?.corpus !== hash || !baselineIsCanonical) {
      entry.baseline = { site: hash, corpus: hash, alignedAt: date };
    }
  }
  manifest.files = normalizedFiles;
  const destinations = new Set((manifest.files ?? []).map((entry) => entry.path));
  for (const [sitePath, destination] of mappings) {
    if (observed.has(sitePath)) continue;
    if (destinations.has(destination)) {
      throw new Error(`crawler transport destination already owned by another manifest entry: ${destination}`);
    }
    const content = contentForSitePath(sitePath, { contractBuffer, payloads, observerPayloads });
    const hash = sha16(content);
    manifest.files.push({
      path: destination,
      sitePath,
      mode: 'identical',
      baseline: { site: hash, corpus: hash, alignedAt: date },
    });
    destinations.add(destination);
  }

  for (const [file, content] of payloads) {
    const destination = path.join(corpusRoot, '.github/workflows', file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  for (const [target, content] of observerPayloads) {
    const destination = path.join(corpusRoot, target);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  const contractDestination = path.join(corpusRoot, CORPUS_CONTRACT_PATH);
  fs.mkdirSync(path.dirname(contractDestination), { recursive: true });
  fs.writeFileSync(contractDestination, contractBuffer);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { artifacts: payloads.size, observers: observerPayloads.size, paths: expectedCorpusPaths(crawlerWorkflowFiles) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [sourceDir, corpusRoot] = process.argv.slice(2);
  if (sourceDir === '--assert-manifest-delta') {
    const baseManifest = JSON.parse(fs.readFileSync(0, 'utf8'));
    const currentManifest = JSON.parse(readRequired(corpusRoot).toString('utf8'));
    assertCrawlerManifestDelta({ baseManifest, currentManifest });
    console.log('Crawler loop-sync manifest delta is confined to its owned baselines.');
    process.exit(0);
  }
  const result = prepareCrawlerWorkflowCorpusSync({ sourceDir, corpusRoot });
  console.log(`Prepared ${result.artifacts} crawler workflow artifacts, ${result.observers} observers, contract and baselines.`);
}
