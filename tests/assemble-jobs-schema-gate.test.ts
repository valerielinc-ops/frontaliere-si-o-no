// tests/assemble-jobs-schema-gate.test.ts
//
// Integration test for the JobSchema gate wired into
// scripts/assemble-jobs-dataset.mjs. Verifies the assembler exits
// non-zero when a slice contains a JobSchema-violating job — proving
// rule #3 (mandatory SEO fields) is enforced at assemble-time, not just
// at downstream build-plugins.
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('assemble-jobs-dataset schema gate', () => {
  it('exits non-zero when a slice contains a job with a malformed url (z.string().url())', () => {
    // We assert via `url` because the assembler auto-enriches/auto-fills many
    // schema-required fields (baseSalary via hardenJobsWithStructuredSalary,
    // hiringOrganization via enrichHiringOrganization, employmentType via
    // enrichEmploymentType, jobLocation/streetAddress via enrichJobLocation,
    // postalCode via the canton-capital fallback). The `url` field has no
    // enrichment path and is required to be a valid URL by JobSchema, making
    // it a stable witness for the gate.
    const tmp = mkdtempSync(join(tmpdir(), 'assemble-gate-'));
    const byCrawler = join(tmp, 'data', 'jobs', 'by-crawler');
    mkdirSync(byCrawler, { recursive: true });

    const malformed = {
      crawlerKey: 'unit-test',
      assembledAt: new Date().toISOString(),
      jobs: [
        {
          id: 'broken-1',
          slug: 'broken-1',
          url: 'not-a-valid-url',  // → JobSchema z.string().url() will reject
          title: 'Bad URL here',
          company: 'Acme',
          hiringOrganization: { name: 'Acme' },
          location: 'Lugano',
          addressLocality: 'Lugano',
          postalCode: '6900',
          streetAddress: 'Via Test 1',
          description: 'A'.repeat(100),
          datePosted: '2026-05-15',
          employmentType: 'FULL_TIME',
          jobLocation: { addressLocality: 'Lugano', postalCode: '6900', addressCountry: 'CH' },
          baseSalary: {
            currency: 'CHF',
            value: { minValue: 60000, maxValue: 90000, unitText: 'YEAR' },
          },
        },
      ],
    };
    writeFileSync(join(byCrawler, 'unit-test.json'), JSON.stringify(malformed));

    let exitCode = 0;
    try {
      execSync(`SLICES_DIR=${byCrawler} node scripts/assemble-jobs-dataset.mjs --validate-only`, { stdio: 'pipe' });
    } catch (e: any) {
      exitCode = e.status ?? 1;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    expect(exitCode).not.toBe(0);
  });
});
