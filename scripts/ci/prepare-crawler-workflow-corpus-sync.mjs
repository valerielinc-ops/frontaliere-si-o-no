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

export const CRAWLER_WORKFLOW_FILES = [
  ...Array.from({ length: 23 }, (_, index) => `crawler-group-${String(index + 1).padStart(2, '0')}.yml`),
  'translate-pending.yml',
];

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
    source: 'observers/scripts/lib/crawler-generation-token.mjs',
    target: 'scripts/ci/lib/crawler-generation-token.mjs',
  },
  {
    source: 'observers/scripts/lib/github-actions-read-client.mjs',
    target: 'scripts/ci/lib/github-actions-read-client.mjs',
  },
];

function sha16(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function readRequired(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`required crawler transport input missing: ${filePath}`);
  }
  return fs.readFileSync(filePath);
}

export function expectedCorpusPaths() {
  return [
    ...CRAWLER_WORKFLOW_FILES.map((file) => `.github/workflows/${file}`),
    ...CORPUS_OBSERVER_FILES.map((observer) => observer.target),
    CORPUS_CONTRACT_PATH,
    CORPUS_MANIFEST_PATH,
  ];
}

function ownedSitePaths() {
  return new Set(expectedMappings().keys());
}

function expectedMappings() {
  return new Map([
    ...CRAWLER_WORKFLOW_FILES.map((file) => `.github/corpus-workflows/${file}`),
  ].map((sitePath) => [sitePath, `.github/workflows/${path.basename(sitePath)}`]).concat(
    CORPUS_OBSERVER_FILES.map(({ source, target }) => [
      `.github/corpus-workflows/${source}`,
      target,
    ]), [
    ['.github/corpus-workflows/contract.json', CORPUS_CONTRACT_PATH],
  ]));
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
export function assertCrawlerManifestDelta({ baseManifest, currentManifest } = {}) {
  if (!baseManifest || !currentManifest) throw new Error('baseManifest and currentManifest are required');
  const expected = structuredClone(baseManifest);
  const currentOwned = new Map();
  for (const entry of currentManifest.files ?? []) {
    if (!ownedSitePaths().has(entry.sitePath)) continue;
    if (currentOwned.has(entry.sitePath)) throw new Error(`duplicate owned crawler manifest entry: ${entry.sitePath}`);
    currentOwned.set(entry.sitePath, entry);
  }
  for (const [sitePath, destination] of expectedMappings()) {
    const current = currentOwned.get(sitePath);
    if (!current || current.path !== destination || current.mode !== 'identical') {
      throw new Error(`owned crawler manifest entry missing or malformed: ${sitePath}`);
    }
    const baseIndex = (expected.files ?? []).findIndex((entry) => entry.sitePath === sitePath);
    if (baseIndex >= 0) expected.files[baseIndex].baseline = structuredClone(current.baseline);
    else expected.files.push(structuredClone(current));
  }
  if (JSON.stringify(currentManifest) !== JSON.stringify(expected)) {
    throw new Error('crawler transport changed loop-sync manifest outside its owned baselines');
  }
}

export function prepareCrawlerWorkflowCorpusSync({ sourceDir, corpusRoot, alignedAt } = {}) {
  if (!sourceDir || !corpusRoot) throw new Error('sourceDir and corpusRoot are required');
  const contractBuffer = readRequired(path.join(sourceDir, 'contract.json'));
  const contract = JSON.parse(contractBuffer.toString('utf8'));
  const contractFiles = (contract.artifacts ?? []).map((artifact) => artifact.file).sort();
  const expectedFiles = [...CRAWLER_WORKFLOW_FILES].sort();
  if (JSON.stringify(contractFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('crawler transport contract must name exactly the 24 executable artifacts');
  }
  if (JSON.stringify(contract.observers ?? []) !== JSON.stringify(
    CORPUS_OBSERVER_FILES.map(({ source, target }) => ({ source, target, sha256: contract.observers?.find((observer) => observer.source === source)?.sha256 })),
  )) {
    throw new Error('crawler transport contract must name exactly the dedicated observers');
  }

  // Leggi e valida tutto PRIMA di scrivere. Un export troncato non puo'
  // cancellare o aggiornare parzialmente il checkout di destinazione.
  const payloads = new Map(CRAWLER_WORKFLOW_FILES.map((file) => [
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

  const manifestPath = path.join(corpusRoot, CORPUS_MANIFEST_PATH);
  const manifest = JSON.parse(readRequired(manifestPath).toString('utf8'));
  const mappings = expectedMappings();
  const observed = new Set();
  const date = alignedAt ?? new Date().toISOString().slice(0, 10);
  for (const entry of manifest.files ?? []) {
    const destination = mappings.get(entry.sitePath);
    if (!destination) continue;
    const keys = Object.keys(entry).sort().join(',');
    if (entry.path !== destination || entry.mode !== 'identical' ||
        keys !== 'baseline,mode,path,sitePath' || observed.has(entry.sitePath)) {
      throw new Error(`invalid or duplicate crawler transport mapping: ${entry.sitePath}`);
    }
    observed.add(entry.sitePath);
    const content = contentForSitePath(entry.sitePath, { contractBuffer, payloads, observerPayloads });
    const hash = sha16(content);
    const baselineKeys = Object.keys(entry.baseline ?? {}).sort();
    const baselineIsCanonical = baselineKeys.join(',') === 'alignedAt,corpus,site' &&
      /^\d{4}-\d{2}-\d{2}$/.test(entry.baseline.alignedAt ?? '');
    if (entry.baseline?.site !== hash || entry.baseline?.corpus !== hash || !baselineIsCanonical) {
      entry.baseline = { site: hash, corpus: hash, alignedAt: date };
    }
  }
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
  return { artifacts: payloads.size, observers: observerPayloads.size, paths: expectedCorpusPaths() };
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
