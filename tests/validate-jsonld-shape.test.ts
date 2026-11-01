import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempRoots: string[] = [];
const scriptPath = path.resolve('scripts/validate-jsonld-shape.mjs');

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function completeJobPosting() {
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Product Manager',
    description: 'A detailed product management role with a Swiss employer and clear responsibilities.',
    datePosted: new Date(Date.now() - 86_400_000).toISOString(),
    validThrough: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    hiringOrganization: { name: 'Example AG' },
    jobLocation: {
      '@type': 'Place',
      address: {
        postalCode: '8001',
        streetAddress: 'Bahnhofstrasse 1',
        addressLocality: 'Zürich',
        addressRegion: 'ZH',
        addressCountry: 'CH',
      },
    },
    employmentType: 'FULL_TIME',
    baseSalary: { currency: 'CHF', value: { minValue: 80000, unitText: 'YEAR' } },
  };
}

function validatePosting(posting: ReturnType<typeof completeJobPosting>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-jsonld-shape-'));
  tempRoots.push(root);
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(
    path.join(dist, 'index.html'),
    `<script type="application/ld+json">${JSON.stringify(posting)}</script>`,
  );
  return spawnSync(process.execPath, [scriptPath, `--dist=${dist}`, '--strict'], { encoding: 'utf8' });
}

describe('validate-jsonld-shape JobPosting mandatory fields', () => {
  it.each([
    ['validThrough', (posting: ReturnType<typeof completeJobPosting>) => { Reflect.deleteProperty(posting, 'validThrough'); }],
    ['jobLocation.address.streetAddress', (posting: ReturnType<typeof completeJobPosting>) => { Reflect.deleteProperty(posting.jobLocation.address, 'streetAddress'); }],
  ])('fails and reports a missing %s', (field, removeField) => {
    const posting = completeJobPosting();
    removeField(posting);

    const result = validatePosting(posting);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(`JobPosting missing ${field}`);
  });
});
