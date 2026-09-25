import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type SemanticLabel = 'preserved' | 'inversion' | 'loss' | 'wrong-language' | 'equal' | 'unclear';

type SemanticCase = {
  id: string;
  source: string;
  sourceLang: string;
  targetLocale: string;
  existing: string;
  candidate: string;
  label: SemanticLabel;
  reason: string;
};

type SemanticDataset = {
  schemaVersion: number;
  description: string;
  labelDefinitions: Record<SemanticLabel, string>;
  cases: SemanticCase[];
};

const FIXTURE_PATH = resolve(process.cwd(), 'tests/fixtures/local-mt-semantic-cases.json');
const EXPECTED_LABELS: SemanticLabel[] = [
  'preserved',
  'inversion',
  'loss',
  'wrong-language',
  'equal',
  'unclear',
];
const LOCALES = new Set(['it', 'en', 'de', 'fr']);
const CASE_KEYS = [
  'id',
  'source',
  'sourceLang',
  'targetLocale',
  'existing',
  'candidate',
  'label',
  'reason',
];

function readDataset(): SemanticDataset {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as SemanticDataset;
}

describe('local MT semantic calibration dataset', () => {
  it('has a deterministic, schema-complete and balanced corpus', () => {
    const firstBytes = readFileSync(FIXTURE_PATH, 'utf8');
    const secondBytes = readFileSync(FIXTURE_PATH, 'utf8');
    const dataset = JSON.parse(firstBytes) as SemanticDataset;
    const secondDataset = JSON.parse(secondBytes) as SemanticDataset;

    expect(firstBytes).toBe(secondBytes);
    expect(secondDataset).toEqual(dataset);
    expect(dataset.schemaVersion).toBe(1);
    expect(dataset.description.trim()).not.toBe('');
    expect(dataset.cases.length).toBeGreaterThanOrEqual(20);
    expect(Object.keys(dataset.labelDefinitions).sort()).toEqual([...EXPECTED_LABELS].sort());
    expect(EXPECTED_LABELS.every((label) => dataset.labelDefinitions[label].trim().length >= 20)).toBe(true);

    const ids = new Set<string>();
    const counts = new Map<SemanticLabel, number>(EXPECTED_LABELS.map((label) => [label, 0]));
    for (const item of dataset.cases) {
      expect(Object.keys(item).sort()).toEqual([...CASE_KEYS].sort());
      expect(ids.has(item.id)).toBe(false);
      ids.add(item.id);
      expect(item.id).toMatch(/^(preserved|inversion|loss|wrong-language|equal|unclear)-\d{2}$/);
      expect(item.source.trim()).not.toBe('');
      expect(LOCALES.has(item.sourceLang)).toBe(true);
      expect(LOCALES.has(item.targetLocale)).toBe(true);
      expect(item.sourceLang).not.toBe(item.targetLocale);
      expect(item.existing.trim()).not.toBe('');
      expect(item.candidate.trim()).not.toBe('');
      expect(EXPECTED_LABELS).toContain(item.label);
      expect(item.reason.trim().length).toBeGreaterThanOrEqual(40);
      expect(item.reason).not.toMatch(/\b(?:todo|tbd|placeholder|fixme)\b/i);
      counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
    }

    const observedCounts = EXPECTED_LABELS.map((label) => counts.get(label) ?? 0);
    expect(Math.min(...observedCounts)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...observedCounts) - Math.min(...observedCounts)).toBeLessThanOrEqual(1);
  });

  it('keeps the labels and case ids aligned, so a relabel cannot silently hide a class', () => {
    const dataset = readDataset();
    for (const item of dataset.cases) {
      expect(item.id.startsWith(`${item.label}-`)).toBe(true);
    }

    for (const label of EXPECTED_LABELS) {
      expect(dataset.cases.filter((item) => item.label === label)).not.toHaveLength(0);
    }
  });

  it('is read-only: loading the fixture does not create or modify corpus output', () => {
    const before = readFileSync(FIXTURE_PATH, 'utf8');
    const dataset = readDataset();
    const after = readFileSync(FIXTURE_PATH, 'utf8');

    expect(dataset.cases.length).toBeGreaterThanOrEqual(20);
    expect(after).toBe(before);
  });
});
