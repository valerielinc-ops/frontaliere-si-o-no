import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateAdapterConfig } from '../scripts/update-pemsa-jobs.mjs';
import { __testables } from '../scripts/lib/shared-jobs-crawler.mjs';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const day = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const timestamp = `${day}T00:15:00+02:00`;
const description = 'Our construction team needs an experienced professional to coordinate projects, supervise quality, document progress and collaborate with colleagues. You will support customers, plan work, follow safety standards and improve processes. We offer professional training, a modern workplace, reliable equipment, flexible hours and opportunities for development in an established company serving the Swiss market.';

describe('Pemsa persisted adapter publication evidence', () => {
  it.each([
    ['reported', { datePosted: timestamp, postedDate: timestamp, postingDateSource: 'reported' }, timestamp],
    ['unknown', { datePosted: timestamp, postedDate: timestamp, postingDateSource: 'unknown' }, ''],
    ['legacy', { postedDate: timestamp }, ''],
    ['invalid', { postedDate: '2025-02-30', postingDateSource: 'reported' }, ''],
  ])('preserves %s provenance through adapter JSON and downstream normalization', (_label, publication, expected) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pemsa-adapter-publication-'));
    temporaryDirectories.push(temporary);
    const output = path.join(temporary, 'adapter.json');
    const url = 'https://www.pemsa.ch/jobs/test-engineer/';
    updateAdapterConfig([{ url, location: 'Lugano', canton: 'TI', ...publication }], output);
    const adapter = JSON.parse(fs.readFileSync(output, 'utf8'));
    const seed = adapter.seedMetaByUrl[url];
    const expectedTuple = { postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' };
    expect(seed).toMatchObject(expectedTuple);
    expect(seed).toMatchObject({ location: 'Lugano', canton: 'TI' });
    const { job } = __testables.toJobFromJsonLd({ '@type': 'JobPosting', title: 'Construction Engineer', description,
      jobLocation: { address: { addressLocality: 'Lugano', addressRegion: 'TI', addressCountry: 'CH' } } }, 'Pemsa', url, { seedMeta: seed });
    expect(job).toMatchObject(expectedTuple);
  });
});
