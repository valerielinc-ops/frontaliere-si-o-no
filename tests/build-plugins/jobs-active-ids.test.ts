import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localeJobsSplitPlugin } from '../../build-plugins/localeJobsSplitPlugin';
import {
  clearJobCanonOrderingFields,
  consumeJobCanonOrderingHandoff,
  getJobCanonOrderingFields,
  jobCanonOrderingHandoffPath,
} from '../../build-plugins/shared/jobCanonInputs';

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

describe('published active job ID index', () => {
  let root = '';
  let previousBuildStage: string | undefined;
  let previousBuildLocale: string | undefined;

  beforeEach(() => {
    previousBuildStage = process.env.BUILD_STAGE;
    previousBuildLocale = process.env.BUILD_LOCALE;
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
    clearJobCanonOrderingFields();
    if (previousBuildStage === undefined) delete process.env.BUILD_STAGE;
    else process.env.BUILD_STAGE = previousBuildStage;
    if (previousBuildLocale === undefined) delete process.env.BUILD_LOCALE;
    else process.env.BUILD_LOCALE = previousBuildLocale;
  });

  it('emits a fresh, deduplicated index from exactly the published listing inventory', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-active-ids-'));
    process.env.BUILD_STAGE = 'single';
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
    const detail = JSON.parse(fs.readFileSync(path.join(root, 'dist/data/job-detail/active-job-1.json'), 'utf8'));
    expect(detail.url).toBe(active.url);
  });

  it('writes and reloads only stable IDs and ordering fields across the bundle/SSG boundary', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-ordering-handoff-'));
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const active = {
      id: 'active-job-1', slug: 'active-job-1', title: 'Engineer', company: 'Acme SA',
      canton: 'TI', location: 'Lugano', datePosted: daysAgo(24).slice(0, 10),
      firstSeenAt: daysAgo(23),
    };
    const noDates = {
      id: 'active-job-2', slug: 'active-job-2', title: 'Analyst', company: 'Acme SA',
      canton: 'TI', location: 'Bellinzona',
    };
    fs.writeFileSync(path.join(root, 'data/jobs.json'), JSON.stringify([
      active,
      noDates,
      { ...active, id: 'fixture-job-1', slug: 'fixture-job-1' },
      { ...active, id: 'foreign-job', location: 'London' },
    ]));

    process.env.BUILD_STAGE = 'bundle';
    delete process.env.BUILD_LOCALE;
    const handoffPath = jobCanonOrderingHandoffPath(root);
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    fs.writeFileSync(handoffPath, 'stale artifact');
    const plugin = localeJobsSplitPlugin(root);
    (plugin.buildStart as () => void)();
    expect(fs.existsSync(handoffPath)).toBe(false);
    (plugin.closeBundle as () => void)();

    const artifact = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
    expect(path.relative(root, handoffPath)).toBe('.cache/job-canon-ordering-fields.json');
    expect(artifact.rows).toEqual([
      { id: 'active-job-1', datePosted: active.datePosted, firstSeenAt: active.firstSeenAt },
      { id: 'active-job-2' },
    ]);
    expect(artifact.rows.every((row: Record<string, unknown>) =>
      Object.keys(row).every((key) => ['id', 'datePosted', 'firstSeenAt'].includes(key)))).toBe(true);
    const [publicRow] = JSON.parse(fs.readFileSync(path.join(root, 'dist/data/jobs-slug-map.json'), 'utf8'));
    expect(publicRow.datePosted).toBeUndefined();
    expect(publicRow.firstSeenAt).toBeUndefined();

    // A fresh SSG process starts with no module state and reloads the small
    // build-only handoff; consumption removes it from the shared workspace.
    clearJobCanonOrderingFields();
    const restored = consumeJobCanonOrderingHandoff(
      handoffPath,
      path.join(root, 'data/jobs.json'),
      root,
    );
    expect(restored.get('active-job-1')).toEqual({
      datePosted: active.datePosted,
      firstSeenAt: active.firstSeenAt,
    });
    expect(restored.get('active-job-2')).toEqual({});
    expect(fs.existsSync(handoffPath)).toBe(false);
  });
});
