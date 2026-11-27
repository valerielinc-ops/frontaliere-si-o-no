import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateExpiredCrawlerSlices } from '../scripts/reconcile-job-slugs.mjs';

const URL_ONE = 'https://jobs.example.com/offer/1001';
const posting = (extra: Record<string, unknown>) => ({
  title: 'Contabile senior',
  company: 'Example SA',
  companyKey: 'example-sa',
  location: 'Lugano',
  ...extra,
});
const active = (previous: string[] = []) => posting({
  id: 'example-1001',
  url: URL_ONE,
  slug: 'contabile-senior-example-lugano',
  slugByLocale: { it: 'contabile-senior-example-lugano' },
  previousSlugsByLocale: { de: previous },
});
const archived = (extra: Record<string, unknown> = {}) => posting({
  sourceIdentity: `url:${URL_ONE}`,
  slug: 'contabile-senior-example-lugano',
  slugByLocale: { it: 'contabile-senior-example-lugano' },
  previousSlugsByLocale: { de: ['buchhalter-example-lugano'] },
  ...extra,
});

describe('updateExpiredCrawlerSlices — a removal never drops a route from tracked data', () => {
  let root: string;
  let activeDir: string;
  let expiredDir: string;
  const write = (dir: string, name: string, value: unknown) => (
    fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`)
  );
  const readExpired = (name = 'example-sa.json') => (
    JSON.parse(fs.readFileSync(path.join(expiredDir, name), 'utf8'))
  );
  const run = (activeJobs: unknown[]) => updateExpiredCrawlerSlices(
    new Set(['contabile-senior-example-lugano']),
    activeJobs,
    { activeDir, expiredDir },
  );

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-retention-'));
    activeDir = path.join(root, 'active');
    expiredDir = path.join(root, 'expired');
    fs.mkdirSync(activeDir);
    fs.mkdirSync(expiredDir);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps the record when one of its routes is served by no tracked record', () => {
    write(activeDir, 'example-sa.json', { jobs: [active()] });
    write(expiredDir, 'example-sa.json', [archived()]);

    run([active()]);

    expect(readExpired()).toEqual([archived()]);
  });

  it('does not count a route that only the in-memory active dataset holds', () => {
    write(activeDir, 'example-sa.json', { jobs: [active()] });
    write(expiredDir, 'example-sa.json', [archived()]);

    run([active(['buchhalter-example-lugano'])]);

    expect(readExpired()).toEqual([archived()]);
  });

  it('removes the record when the tracked active slice serves all its routes', () => {
    write(activeDir, 'example-sa.json', { jobs: [active(['buchhalter-example-lugano'])] });
    write(expiredDir, 'example-sa.json', [archived()]);

    run([active(['buchhalter-example-lugano'])]);

    expect(readExpired()).toEqual([]);
  });

  it('removes the record when a retained expired record in another file serves the route', () => {
    const keeper = posting({
      title: 'Altro ruolo',
      slug: 'altro-ruolo-example-lugano',
      previousSlugsByLocale: { de: ['buchhalter-example-lugano'] },
    });
    write(activeDir, 'example-sa.json', { jobs: [active()] });
    write(expiredDir, 'example-sa.json', [archived()]);
    write(expiredDir, 'example-sa.shard-001.json', [keeper]);

    run([active()]);

    expect(readExpired()).toEqual([]);
    expect(readExpired('example-sa.shard-001.json')).toEqual([keeper]);
  });

  it('does not let two removal candidates vouch for each other', () => {
    write(activeDir, 'example-sa.json', { jobs: [active()] });
    write(expiredDir, 'example-sa.json', [archived()]);
    write(expiredDir, 'example-sa.shard-001.json', [archived()]);

    run([active()]);

    expect(readExpired()).toEqual([archived()]);
    expect(readExpired('example-sa.shard-001.json')).toEqual([archived()]);
  });

  it('keeps the record when the active slice cannot be read', () => {
    fs.writeFileSync(path.join(activeDir, 'example-sa.json'), '{');
    write(expiredDir, 'example-sa.json', [archived()]);

    run([active(['buchhalter-example-lugano'])]);

    expect(readExpired()).toEqual([archived()]);
  });
});
