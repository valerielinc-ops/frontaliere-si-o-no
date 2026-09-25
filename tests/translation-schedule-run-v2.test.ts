import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectTranslationSchedulerInput,
  runTranslationScheduleV2,
} from '../scripts/translation-schedule-run-v2.mjs';

const roots: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createRepositories() {
  const root = mkdtempSync(join(tmpdir(), 'translation-scheduler-v2-test-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  git(root, 'init', '-q', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '-q', '--initial-branch=main', seed);
  git(seed, 'config', 'user.name', 'Translation Scheduler Test');
  git(seed, 'config', 'user.email', 'translation-scheduler-test@example.test');

  const dataDirectory = join(seed, 'data/jobs/by-crawler');
  mkdirSync(dataDirectory, { recursive: true });
  const description = 'This role supports international projects and coordinates a multilingual team. '
    + 'You will plan delivery, collaborate with engineering, and communicate clearly with partners. '
    + 'The position combines ownership, careful documentation, and practical problem solving.';
  writeFileSync(join(dataDirectory, 'example-crawler.json'), `${JSON.stringify({
    crawlerKey: 'example-crawler',
    assembledAt: new Date().toISOString(),
    jobs: [{
      id: 'job-1',
      url: 'https://jobs.example.test/positions/job-1/',
      slug: 'senior-developer-international-projects',
      title: 'Senior developer for international projects',
      description,
      sourceLang: 'en',
      company: 'Example AG',
      location: 'Zurich',
      titleByLocale: {
        en: 'Senior developer for international projects',
        it: '',
        de: 'Senior Entwickler für internationale Projekte',
        fr: 'Développeur senior pour projets internationaux',
      },
      descriptionByLocale: {
        en: description,
        it: 'Questo ruolo sostiene progetti internazionali e coordina un team multilingue. '
          + 'Pianificherai le consegne, collaborerai con il team tecnico e comunicherai con i partner. '
          + 'La posizione richiede responsabilità, documentazione e problem solving pratico.',
        de: 'Diese Position unterstützt internationale Projekte und koordiniert ein mehrsprachiges Team. '
          + 'Sie planen Lieferungen, arbeiten mit dem Engineering zusammen und kommunizieren klar mit Partnern. '
          + 'Die Stelle verbindet Verantwortung, Dokumentation und praktische Problemlösung.',
        fr: 'Ce poste accompagne des projets internationaux et coordonne une équipe multilingue. '
          + 'Vous planifiez les livraisons, collaborez avec l’ingénierie et communiquez clairement. '
          + 'La fonction combine responsabilité, documentation et résolution pratique des problèmes.',
      },
    }],
  }, null, 2)}\n`);
  const providerSource = `export function translate(request, { succeedText }) {
  if (request.field !== 'title') throw new Error('unexpected field');
  succeedText('Sviluppatore senior per progetti internazionali');
}
`;
  const providerPath = join(seed, 'scripts/lib/translation-shadow-provider-v2.mjs');
  mkdirSync(join(seed, 'scripts/lib'), { recursive: true });
  writeFileSync(providerPath, providerSource);
  git(seed, 'add', 'data/jobs/by-crawler/example-crawler.json', 'scripts/lib/translation-shadow-provider-v2.mjs');
  git(seed, 'commit', '-q', '-m', 'seed translation scheduler fixture');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'HEAD:main');

  const one = join(root, 'one');
  git(root, 'clone', '-q', remote, one);
  git(one, 'config', 'user.name', 'Translation Scheduler Test');
  git(one, 'config', 'user.email', 'translation-scheduler-test@example.test');

  return { one, remote };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('translation scheduler v2 runtime wiring', () => {
  it('uses the Italian default for legacy jobs without sourceLang', async () => {
    const { one } = createRepositories();
    const slicePath = join(one, 'data/jobs/by-crawler/example-crawler.json');
    const slice = JSON.parse(readFileSync(slicePath, 'utf8'));
    const job = slice.jobs[0];
    delete job.sourceLang;
    job.title = 'Sviluppatore senior per progetti internazionali';
    job.description = job.descriptionByLocale.it;
    job.titleByLocale = {
      it: job.title,
      en: 'Senior developer for international projects',
      de: '',
      fr: 'Développeur senior pour projets internationaux',
    };
    writeFileSync(slicePath, `${JSON.stringify(slice, null, 2)}\n`);

    const input = await collectTranslationSchedulerInput({ repository: one });

    expect(input.metrics.selectedInputUnits).toBe(1);
    expect(input.runtimeJobs[0].units[0].identity.sourceLocale).toBe('it');
    expect(input.runtimeJobs[0].units[0].identity.targetLocale).toBe('de');
  });

  it('plans, reserves, executes, and settles on the state ref without writing main', async () => {
    const { one, remote } = createRepositories();
    const mainBefore = git(one, 'rev-parse', 'HEAD');
    const sourceBefore = readFileSync(
      join(one, 'data/jobs/by-crawler/example-crawler.json'),
      'utf8',
    );

    const report = await runTranslationScheduleV2({
      repository: one,
      maxJobs: 10,
      maxUnits: 1,
      providerTimeoutMs: 10_000,
      logger: { log() {} },
    });

    expect(report.status).toBe('settled');
    expect(report.runtimeContract).toMatchObject({
      schemaVersion: 2,
      provider: {
        modulePath: 'scripts/lib/translation-shadow-provider-v2.mjs',
        exportName: 'translate',
        schemaVersion: 3,
        engineVersion: 'shadow-engine-v2',
      },
      capabilities: { generationEnabled: false, publishEnabled: false },
    });
    expect(report.scheduler.selectedJobs).toBe(1);
    expect(report.scheduler.selectedUnits).toBe(1);
    expect(report.canary).toMatchObject({
      plannedUnits: 1,
      eligibleUnits: 0,
      selected: 0,
      skipped: 1,
    });
    expect(report.scheduler.outcomeCounts).toMatchObject({ canary_skipped: 1 });
    expect(report.scheduler.settlement).toMatchObject({ generated: 0, validated: 0 });
    expect(report.candidates).toEqual({ validated: 0, rejected: 0 });
    expect(report.state.reserved).toBe(true);
    expect(report.state.settled).toBe(true);
    expect(report.stateRemote).toBe('origin');
    expect(report.stateRef).toBe('refs/heads/translation-state-v2');
    expect(git(one, 'rev-parse', 'HEAD')).toBe(mainBefore);
    expect(git(one, 'ls-remote', '--refs', remote, 'refs/heads/main')).toContain(mainBefore);
    expect(readFileSync(join(one, 'data/jobs/by-crawler/example-crawler.json'), 'utf8'))
      .toBe(sourceBefore);
    expect(git(one, 'ls-remote', '--refs', remote, report.stateRef)).toContain(report.state.after);
    expect(git(one, 'ls-tree', '-r', '--name-only', report.state.after))
      .toContain('v2/scheduler/');
  });

  it('does not call the provider at the zero-exposure default', async () => {
    const { one } = createRepositories();
    const providerModule = join(one, 'scripts/lib/translation-shadow-provider-v2.mjs');
    writeFileSync(providerModule, `export function translate() {
  throw new Error('provider must not be called for a zero-exposure canary');
}
`);

    const report = await runTranslationScheduleV2({
      repository: one,
      maxJobs: 10,
      maxUnits: 1,
      providerTimeoutMs: 10_000,
      logger: { log() {} },
    });

    expect(report.canary).toMatchObject({ selected: 0, skipped: 1 });
    expect(report.scheduler.outcomeCounts.canary_skipped).toBe(1);
    expect(report.scheduler.outcomeCounts).not.toHaveProperty('generation_failed');
  });

  it('returns an empty report when the live queue has no pending units', async () => {
    const { one } = createRepositories();
    const slicePath = join(one, 'data/jobs/by-crawler/example-crawler.json');
    const slice = JSON.parse(readFileSync(slicePath, 'utf8'));
    slice.jobs = [];
    writeFileSync(slicePath, `${JSON.stringify(slice, null, 2)}\n`);

    const report = await runTranslationScheduleV2({
      repository: one,
      logger: { log() {} },
    });

    expect(report).toMatchObject({
      status: 'empty',
      scheduler: { selectedJobs: 0, selectedUnits: 0 },
      state: { reserved: false, settled: false },
    });
  });

  // A CI runner has no `user.email` in git config, and the state store wrote its
  // commits through `commit-tree`, which takes the author from config when the
  // environment carries none — so the first real run that got past the slice
  // scan died with `git commit-tree failed: Author identity unknown`. No local
  // test could catch it, because `createRepositories()` runs `git config
  // user.email` on its clone: the fixture handed the library the very ambient
  // identity that production does not have. This case removes it, and also
  // points GIT_CONFIG_GLOBAL/SYSTEM at /dev/null so the developer's own
  // ~/.gitconfig cannot silently stand in for the runner's empty one.
  it('commits on the state ref without any ambient git identity', async () => {
    const { one, remote } = createRepositories();
    git(one, 'config', '--unset', 'user.name');
    git(one, 'config', '--unset', 'user.email');
    const previous = {
      global: process.env.GIT_CONFIG_GLOBAL,
      system: process.env.GIT_CONFIG_SYSTEM,
    };
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    try {
      const report = await runTranslationScheduleV2({
        repository: one,
        maxJobs: 10,
        maxUnits: 1,
        providerTimeoutMs: 10_000,
        logger: { log() {} },
      });

      expect(report.status).toBe('settled');
      expect(report.scheduler.selectedUnits).toBe(1);
      // The commit really exists on the ref, not just "no throw".
      expect(git(one, 'ls-remote', '--refs', remote, report.stateRef)).toContain(report.state.after);
    } finally {
      if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous.global;
      if (previous.system === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = previous.system;
    }
  });

  // `data/jobs/by-crawler/` is not a directory of slices only: a crawler writes a
  // `<key>-locale-cache.json` scratch companion next to its slice, and a housekeeping
  // run killed mid-write leaves a `<key>.json.cleanup-tmp.json` behind. Both are
  // real files on main — `coop-ticino-locale-cache.json` is a bare `[]` — and this
  // scanner read them as slices, so every shadow run since the workflow was created
  // died on `… must be an object` and never produced its report. The shared
  // `isSliceFile` predicate exists for exactly this; the scanner has to use it.
  it('skips crawler scratch companions instead of reading them as slices', async () => {
    const { one, remote } = createRepositories();
    const dataDirectory = join(one, 'data/jobs/by-crawler');
    // Verbatim shape of the file that failed in production: a bare empty array.
    writeFileSync(join(dataDirectory, 'coop-ticino-locale-cache.json'), '[]\n');
    writeFileSync(join(dataDirectory, 'example-crawler.json.cleanup-tmp.json'), '[]\n');

    const report = await runTranslationScheduleV2({
      repository: one,
      maxJobs: 10,
      maxUnits: 1,
      providerTimeoutMs: 10_000,
      logger: { log() {} },
    });

    // The run completes and still does its real work; the decoys are not counted.
    expect(report.status).toBe('settled');
    expect(report.scan.filesScanned).toBe(1);
    expect(report.scheduler.selectedUnits).toBe(1);
    // The scratch files stay untouched on disk — skipped, not repaired or deleted.
    expect(readFileSync(join(dataDirectory, 'coop-ticino-locale-cache.json'), 'utf8')).toBe('[]\n');
    expect(git(one, 'ls-remote', '--refs', remote, report.stateRef)).toContain(report.state.after);
  });

  it.each([
    ['main ref', { stateRef: 'refs/heads/main' }],
    ['non-dedicated ref', { stateRef: 'refs/heads/translation-state-other-v2' }],
    ['non-authorized remote', { stateRemote: 'backup' }],
  ])('rejects an unauthorized state target before any scheduler work (%s)', async (_label, target) => {
    const { one, remote } = createRepositories();

    await expect(runTranslationScheduleV2({ repository: one, ...target, logger: { log() {} } }))
      .rejects.toThrow(/translation state writes must target origin\/refs\/heads\/translation-state-v2/);
    expect(git(one, 'rev-parse', 'HEAD')).toBe(git(one, 'rev-parse', 'origin/main'));
    expect(git(one, 'ls-remote', '--refs', remote, 'refs/heads/main'))
      .toContain(git(one, 'rev-parse', 'origin/main'));
  });

  it('rejects an injected state store without an explicit remote before initialization', async () => {
    let initialized = false;
    const stateStore = {
      ref: 'refs/heads/translation-state-v2',
      async initialize() {
        initialized = true;
      },
    };

    await expect(runTranslationScheduleV2({ repository: 'unused-repository', stateStore, logger: { log() {} } }))
      .rejects.toThrow(/translation state writes must target origin\/refs\/heads\/translation-state-v2/);
    expect(initialized).toBe(false);
  });

  it('binds the shadow workflow permission and state destination to the same contract', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/translation-schedule-v2-shadow.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toMatch(/permissions:\n  contents: write/u);
    expect(workflow).toMatch(/TRANSLATION_STATE_REMOTE_V2:\s*origin/u);
    expect(workflow).toMatch(/TRANSLATION_STATE_REF_V2:\s*refs\/heads\/translation-state-v2/u);
    expect(workflow).toContain('node scripts/translation-schedule-run-v2.mjs --shadow');
  });
});
