import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MANDATORY_JOBPOSTING_FIELDS,
  OPTIONAL_JOBPOSTING_FIELDS,
  validateMandatoryJobPostingFields,
} from '../../scripts/lib/jobposting-mandatory-fields.mjs';

const ROOT = resolve(__dirname, '..', '..');

// Google's required set: missing or empty is an error.
const FIELD_CASES = [
  ['title', 'title'],
  ['description', 'description'],
  ['datePosted', 'datePosted'],
  ['hiringOrganization.name', 'hiringOrganization.name'],
  ['jobLocation', 'jobLocation'],
  ['jobLocation.address.addressLocality', 'jobLocation.address.addressLocality'],
  ['jobLocation.address.addressCountry', 'jobLocation.address.addressCountry'],
] as const;

// Owner decision 2026-10-24: present only when the source states them.
// Absent is the contract; present-but-empty is an error.
const OPTIONAL_CASES = [
  ['employmentType', 'employmentType'],
  ['jobLocation.address.postalCode', 'jobLocation.address.postalCode'],
  ['jobLocation.address.streetAddress', 'jobLocation.address.streetAddress'],
  ['baseSalary', 'baseSalary'],
] as const;

type MutableJsonObject = Record<string, unknown>;

function validJobPosting(): MutableJsonObject {
  return {
    title: 'Tecnico di laboratorio',
    description:
      'Descrizione sufficientemente lunga per esercitare il contratto condiviso del JobPosting senza usare un default vuoto.',
    datePosted: '2026-09-30T00:00:00.000Z',
    employmentType: 'FULL_TIME',
    hiringOrganization: { name: 'Azienda Fixture SA' },
    jobLocation: {
      address: {
        postalCode: '6900',
        streetAddress: 'Via Fixture 1',
        addressLocality: 'Lugano',
        addressRegion: 'TI',
        addressCountry: 'CH',
      },
    },
    baseSalary: {
      currency: 'CHF',
      value: { minValue: 72000, maxValue: 96000, unitText: 'YEAR' },
    },
  };
}

function setPath(target: MutableJsonObject, path: string, value: unknown) {
  const parts = path.split('.');
  const key = parts.pop() as string;
  let parent = target;
  for (const part of parts) parent = parent[part] as MutableJsonObject;
  parent[key] = value;
}

function deletePath(target: MutableJsonObject, path: string) {
  const parts = path.split('.');
  const key = parts.pop() as string;
  let parent = target;
  for (const part of parts) parent = parent[part] as MutableJsonObject;
  delete parent[key];
}

describe('JobPosting mandatory-field contract (#10499)', () => {
  it('requires exactly Google\'s required JobPosting field paths', () => {
    expect(MANDATORY_JOBPOSTING_FIELDS).toEqual(FIELD_CASES.map(([, field]) => field));
    expect(OPTIONAL_JOBPOSTING_FIELDS).toEqual(expect.arrayContaining(OPTIONAL_CASES.map(([, field]) => field)));
  });

  it.each(OPTIONAL_CASES)('accepts a JobPosting without the optional %s field', (_label, field) => {
    const schema = validJobPosting();
    deletePath(schema, field);
    expect(validateMandatoryJobPostingFields(schema)).toEqual([]);
  });

  it.each(OPTIONAL_CASES)('rejects an empty optional %s field', (_label, field) => {
    const schema = validJobPosting();
    setPath(schema, field, '');
    expect(validateMandatoryJobPostingFields(schema).map((error) => error.field).join(' ')).toContain(field);
  });

  it('accepts several stated employment types and a salary without an upper bound', () => {
    const schema = validJobPosting();
    schema.employmentType = ['FULL_TIME', 'TEMPORARY'];
    (schema.baseSalary as MutableJsonObject).value = { minValue: 72000, unitText: 'YEAR' };
    expect(validateMandatoryJobPostingFields(schema)).toEqual([]);
    schema.employmentType = ['FULL_TIME', 'PERMANENT'];
    expect(validateMandatoryJobPostingFields(schema).map((error) => error.field)).toContain('employmentType');
  });

  it('accepts a valid default fixture', () => {
    expect(validateMandatoryJobPostingFields(validJobPosting())).toEqual([]);
  });

  it('measures the minimum description length after trimming whitespace', () => {
    const schema = validJobPosting();
    schema.description = `x${' '.repeat(49)}`;

    expect(validateMandatoryJobPostingFields(schema)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'description' }),
    ]));
  });

  it('rejects non-finite salary values', () => {
    const maxInfinity = validJobPosting();
    (maxInfinity.baseSalary as MutableJsonObject).value = {
      minValue: 1,
      maxValue: 'Infinity',
      unitText: 'YEAR',
    };
    expect(validateMandatoryJobPostingFields(maxInfinity).map((error) => error.field))
      .toContain('baseSalary.value.maxValue');

    const minInfinity = validJobPosting();
    (minInfinity.baseSalary as MutableJsonObject).value = {
      minValue: 'Infinity',
      maxValue: 96000,
      unitText: 'YEAR',
    };
    expect(validateMandatoryJobPostingFields(minInfinity).map((error) => error.field))
      .toContain('baseSalary.value.minValue');
  });

  it.each(FIELD_CASES)('rejects a missing %s field', (_label, field) => {
    const schema = validJobPosting();
    deletePath(schema, field);
    expect(validateMandatoryJobPostingFields(schema).map((error) => error.field)).toContain(field);
  });

  it.each(FIELD_CASES)('rejects an empty %s field', (_label, field) => {
    const schema = validJobPosting();
    setPath(schema, field, '');
    expect(validateMandatoryJobPostingFields(schema).map((error) => error.field)).toContain(field);
  });

  it('is imported by every JobPosting validator entry point', () => {
    const consumers = [
      'scripts/validate-jobposting-schema.mjs',
      'scripts/validate-structured-data-completeness.mjs',
      'scripts/audit-dist-multi.mjs',
    ];
    for (const relativePath of consumers) {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source).toContain("jobposting-mandatory-fields.mjs");
      expect(source).toContain('validateMandatoryJobPostingFields');
    }
  });
});
