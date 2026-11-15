import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localeJobsSplitPlugin } from '../../build-plugins/localeJobsSplitPlugin';
import { clearJobCanonOrderingFields, getJobCanonOrderingFields } from '../../build-plugins/shared/jobCanonInputs';

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

describe('published active job ID index', () => {
  let root = '';
  let previousOrderingHandoffPath: string | undefined;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
    clearJobCanonOrderingFields();
    if (previousOrderingHandoffPath === undefined) delete process.env.BUILD_JOB_CANON_ORDERING_HANDOFF_PATH;
    else process.env.BUILD_JOB_CANON_ORDERING_HANDOFF_PATH = previousOrderingHandoffPath;
    previousOrderingHandoffPath = undefined;
  });

  it('emits a fresh, deduplicated index from exactly the published listing inventory', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-active-ids-'));
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const active = {
      id: 'active-job-1', slug: 'active-job-1', title: 'Engineer', company: 'Acme SA',
      canton: 'TI', location: 'Lugano', url: 'https://jobs.example.test/active-job-1',
      datePosted: daysAgo(24).slice(0, 10), firstSeenAt: daysAgo(23),
    };
    fs.writeFileSync(path.join(root, 'data/jobs.json'), JSON.stringify([
      active,
      { ...active, slug: 'duplicate-active-route' },
      { slug: 'slug-only-job', title: 'Analyst', company: 'Acme SA', canton: 'ZH', location: 'Zürich' },
      { id: 'foreign-job', title: 'Engineer abroad', company: 'Acme SA', location: 'London' },
      { id: 'missing-title', title: '  ', company: 'Acme SA', canton: 'TI', location: 'Lugano' },
    ]));

    previousOrderingHandoffPath = process.env.BUILD_JOB_CANON_ORDERING_HANDOFF_PATH;
    const handoffPath = path.join(root, '.cache', 'job-canon-ordering-fields.json');
    process.env.BUILD_JOB_CANON_ORDERING_HANDOFF_PATH = handoffPath;
    (localeJobsSplitPlugin(root).closeBundle as () => void)();
    const index = JSON.parse(fs.readFileSync(path.join(root, 'dist/data/jobs-active-ids.json'), 'utf8'));

    expect(index.schemaVersion).toBe(1);
    expect(Number.isFinite(Date.parse(index.generatedAt))).toBe(true);
    expect(index.total).toBe(2);
    expect(index.ids).toEqual(['active-job-1', 'slug-only-job']);
    expect(new Set(index.ids).size).toBe(index.ids.length);
    const [slugMapEntry] = JSON.parse(fs.readFileSync(path.join(root, 'dist/data/jobs-slug-map.json'), 'utf8'));
    expect(slugMapEntry.datePosted).toBeUndefined();
    expect(slugMapEntry.firstSeenAt).toBeUndefined();
    expect(getJobCanonOrderingFields()?.get('active-job-1')).toEqual({
      datePosted: active.datePosted,
      firstSeenAt: active.firstSeenAt,
    });
    const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8')) as Array<[string, Record<string, unknown>]>;
    expect(handoff).toContainEqual(['active-job-1', {
      datePosted: active.datePosted,
      firstSeenAt: active.firstSeenAt,
    }]);
    expect(handoff).toContainEqual(['slug-only-job', {}]);
    const detail = JSON.parse(fs.readFileSync(path.join(root, 'dist/data/job-detail/active-job-1.json'), 'utf8'));
    expect(detail.url).toBe(active.url);
  });
});
