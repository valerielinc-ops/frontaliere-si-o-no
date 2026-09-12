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
import { runTranslationScheduleV2 } from '../scripts/translation-schedule-run-v2.mjs';

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
    assembledAt: '2026-09-01T00:00:00.000Z',
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
  git(seed, 'add', 'data/jobs/by-crawler/example-crawler.json');
  git(seed, 'commit', '-q', '-m', 'seed translation scheduler fixture');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'HEAD:main');

  const one = join(root, 'one');
  git(root, 'clone', '-q', remote, one);
  git(one, 'config', 'user.name', 'Translation Scheduler Test');
  git(one, 'config', 'user.email', 'translation-scheduler-test@example.test');

  const providerModule = join(root, 'provider.mjs');
  writeFileSync(providerModule, `export function translate(request, { succeedText }) {
  if (request.field !== 'title') throw new Error('unexpected field');
  succeedText('Sviluppatore senior per progetti internazionali');
}
`);
  return { one, providerModule, remote };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('translation scheduler v2 runtime wiring', () => {
  it('plans, reserves, executes, and settles on the state ref without writing main', async () => {
    const { one, providerModule, remote } = createRepositories();
    const mainBefore = git(one, 'rev-parse', 'HEAD');
    const sourceBefore = readFileSync(
      join(one, 'data/jobs/by-crawler/example-crawler.json'),
      'utf8',
    );

    const report = await runTranslationScheduleV2({
      repository: one,
      providerModule,
      maxJobs: 10,
      maxUnits: 1,
      providerTimeoutMs: 10_000,
      logger: { log() {} },
    });

    expect(report.status).toBe('settled');
    expect(report.scheduler.selectedJobs).toBe(1);
    expect(report.scheduler.selectedUnits).toBe(1);
    expect(report.state.reserved).toBe(true);
    expect(report.state.settled).toBe(true);
    expect(git(one, 'rev-parse', 'HEAD')).toBe(mainBefore);
    expect(git(one, 'ls-remote', '--refs', remote, 'refs/heads/main')).toContain(mainBefore);
    expect(readFileSync(join(one, 'data/jobs/by-crawler/example-crawler.json'), 'utf8'))
      .toBe(sourceBefore);
    expect(git(one, 'ls-remote', '--refs', remote, report.stateRef)).toContain(report.state.after);
    expect(git(one, 'ls-tree', '-r', '--name-only', report.state.after))
      .toContain('v2/scheduler/');
  });
});
