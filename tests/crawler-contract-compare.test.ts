import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_ATTESTATION_FIELD_PATHS,
  contractContentEquals,
  stripContractAttestation,
} from '../scripts/lib/crawler-contract-compare.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CONTRACT_PATH = path.join(REPO_ROOT, '.github/corpus-workflows/contract.json');
const EXPECTED_ATTESTATION_PATHS = [
  ['sourceCommit'],
  ['sourceCommitVerified'],
  ['artifactObservation', 'sourceCommit'],
  ['crawlerRosterCardinality', 'sourceCommit'],
  ['checkout', 'treeMb'],
];

function exampleContract() {
  return {
    sourceCommit: 'a'.repeat(40),
    sourceCommitVerified: true,
    artifactObservation: { sourceCommit: 'a'.repeat(40) },
    crawlerRosterCardinality: { sourceCommit: 'a'.repeat(40) },
    checkout: { treeMb: 4096, excludedMb: 128, excludedBuckets: ['public/images/'], attempts: 3 },
    generatorSha256: 'b'.repeat(64),
    crawlerCount: 707,
    artifacts: [{ file: 'crawler-group-01.yml', sha256: 'c'.repeat(64) }],
    crawlerGeneration: { rosterDigest: 'sha256:digest' },
    siteRuntimePaths: ['scripts/assemble-jobs-dataset.mjs'],
  };
}

function getAtPath(value: Record<string, any>, fieldPath: string[]) {
  return fieldPath.reduce((current, key) => current[key], value);
}

function setAtPath(value: Record<string, any>, fieldPath: string[], nextValue: unknown) {
  const parent = fieldPath.slice(0, -1).reduce((current, key) => current[key], value);
  parent[fieldPath.at(-1)!] = nextValue;
}

function realContract() {
  return JSON.parse(fs.readFileSync(REAL_CONTRACT_PATH, 'utf8'));
}

function suspiciousKeyPaths(value: unknown, prefix: string[] = []): string[][] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => suspiciousKeyPaths(entry, [...prefix, String(index)]));
  }
  if (!value || typeof value !== 'object') return [];

  return Object.entries(value).flatMap(([key, child]) => {
    const fieldPath = [...prefix, key];
    const matchingPath = /commit|verified|treemb/i.test(key) ? [fieldPath] : [];
    return [...matchingPath, ...suspiciousKeyPaths(child, fieldPath)];
  });
}

describe('crawler contract content comparison', () => {
  it('keeps the explicit list of five attestation paths', () => {
    expect(CONTRACT_ATTESTATION_FIELD_PATHS).toEqual(EXPECTED_ATTESTATION_PATHS);
  });

  it.each(EXPECTED_ATTESTATION_PATHS)('ignores attestation path %s', (...fieldPath) => {
    const committed = exampleContract();
    const generated = structuredClone(committed);
    const oldValue = getAtPath(generated, fieldPath);
    setAtPath(generated, fieldPath, typeof oldValue === 'boolean' ? !oldValue : `${oldValue}-changed`);

    expect(contractContentEquals(committed, generated)).toBe(true);
  });

  it('ignores all five attestation values changed together', () => {
    const committed = exampleContract();
    const generated = structuredClone(committed);
    for (const fieldPath of EXPECTED_ATTESTATION_PATHS) {
      const oldValue = getAtPath(generated, fieldPath);
      setAtPath(generated, fieldPath, typeof oldValue === 'boolean' ? !oldValue : `${oldValue}-changed`);
    }

    expect(contractContentEquals(committed, generated)).toBe(true);
  });

  it.each([
    ['generatorSha256', (contract: any) => { contract.generatorSha256 += '-changed'; }],
    ['crawlerCount', (contract: any) => { contract.crawlerCount += 1; }],
    ['artifacts[].sha256', (contract: any) => { contract.artifacts[0].sha256 = 'e'.repeat(64); }],
    ['crawlerGeneration.rosterDigest', (contract: any) => { contract.crawlerGeneration.rosterDigest += '-changed'; }],
    ['siteRuntimePaths[]', (contract: any) => { contract.siteRuntimePaths[0] += '.changed'; }],
    ['checkout.excludedMb', (contract: any) => { contract.checkout.excludedMb += 1; }],
    ['checkout.excludedBuckets[]', (contract: any) => { contract.checkout.excludedBuckets[0] += 'changed'; }],
    ['checkout.attempts', (contract: any) => { contract.checkout.attempts += 1; }],
    ['unknown top-level field', (contract: any) => { contract.futureField = 'new content'; }],
  ])('compares content field %s', (_field, change) => {
    const committed = exampleContract();
    const generated = structuredClone(committed);
    change(generated);

    expect(contractContentEquals(committed, generated)).toBe(false);
  });

  it('strips a copy without mutating input and tolerates missing paths', () => {
    const input = exampleContract();
    const before = structuredClone(input);
    const stripped = stripContractAttestation(input);

    expect(input).toEqual(before);
    expect(stripped).not.toBe(input);
    expect(() => stripContractAttestation({})).not.toThrow();
    expect(stripContractAttestation({})).toEqual({});
  });

  it('requires every real contract commit, verification, and treeMb key to be explicitly classified', () => {
    const coveredPaths = new Set(CONTRACT_ATTESTATION_FIELD_PATHS.map((fieldPath) => fieldPath.join('.')));
    const uncoveredPaths = suspiciousKeyPaths(realContract())
      .map((fieldPath) => fieldPath.join('.'))
      .filter((fieldPath) => !coveredPaths.has(fieldPath));

    expect(uncoveredPaths, 'Decide whether each uncovered path is attestation or content and classify it explicitly.')
      .toEqual([]);
  });

  it('compares the real contract content while ignoring only its five attestation values', () => {
    const committed = realContract();
    const generated = structuredClone(committed);
    for (const fieldPath of EXPECTED_ATTESTATION_PATHS) {
      const oldValue = getAtPath(generated, fieldPath);
      setAtPath(generated, fieldPath, typeof oldValue === 'boolean' ? !oldValue : `${oldValue}-changed`);
    }

    expect(contractContentEquals(committed, generated)).toBe(true);

    generated.crawlerCount += 1;
    expect(contractContentEquals(committed, generated)).toBe(false);
  });
});
