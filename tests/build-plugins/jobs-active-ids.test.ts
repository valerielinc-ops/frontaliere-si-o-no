import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localeJobsSplitPlugin } from '../../build-plugins/localeJobsSplitPlugin';

describe('published active job ID index', () => {
  let root = '';

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('emits a fresh, deduplicated index from exactly the published listing inventory', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-active-ids-'));
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const active = {
      id: 'active-job-1', slug: 'active-job-1', title: 'Engineer', company: 'Acme SA',
      canton: 'TI', location: 'Lugano', url: 'https://jobs.example.test/active-job-1',
    };
    fs.writeFileSync(path.join(root, 'data/jobs.json'), JSON.stringify([
      active,
      { ...active, slug: 'duplicate-active-route' },
      { slug: 'slug-only-job', title: 'Analyst', company: 'Acme SA', canton: 'ZH', location: 'Zürich' },
      { id: 'foreign-job', title: 'Engineer abroad', company: 'Acme SA', location: 'London' },
      { id: 'missing-title', title: '  ', company: 'Acme SA', canton: 'TI', location: 'Lugano' },
    ]));

    (localeJobsSplitPlugin(root).closeBundle as () => void)();
    const index = JSON.parse(fs.readFileSync(path.join(root, 'dist/data/jobs-active-ids.json'), 'utf8'));

    expect(index.schemaVersion).toBe(1);
    expect(Number.isFinite(Date.parse(index.generatedAt))).toBe(true);
    expect(index.total).toBe(2);
    expect(index.ids).toEqual(['active-job-1', 'slug-only-job']);
    expect(new Set(index.ids).size).toBe(index.ids.length);
  });
});
