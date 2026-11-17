import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cxsCallers = [
  {
    file: 'scripts/update-trumpf-jobs.mjs',
    helpers: ['fetchWorkdayJsonWithRetry'],
  },
  {
    file: 'scripts/update-hamilton-jobs.mjs',
    helpers: ['fetchWorkdayJobDetail'],
  },
  {
    file: 'scripts/lib/otis-job-parser.mjs',
    helpers: ['fetchWorkdayJsonWithRetry', 'fetchWorkdayJobDetail'],
  },
  {
    file: 'scripts/lib/logitech-job-parser.mjs',
    helpers: ['fetchWorkdayJobDetail'],
  },
] as const;

describe('Workday CXS crawler transport', () => {
  it.each(cxsCallers)('$file routes CXS requests through the shared retry client', ({ file, helpers }) => {
    const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

    for (const helper of helpers) expect(source).toContain(helper);
    expect(source).not.toMatch(/\bawait\s+fetch\s*\(/);
  });
});
