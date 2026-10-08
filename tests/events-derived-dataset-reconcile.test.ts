import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVENT_DESCRIPTION_REWRITE_MODEL,
  EVENT_DESCRIPTION_PROMPT_VERSION,
  sourceDescriptionHash,
} from '../scripts/lib/event-description-policy.mjs';

const ROOT = path.resolve(__dirname, '..');
const RECONCILE_SCRIPT = path.join(ROOT, 'scripts/ci/reconcile-data-refresh-main.mjs');
const TEST_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'events-reconcile-test',
  GIT_AUTHOR_EMAIL: 'events-reconcile-test@example.invalid',
  GIT_COMMITTER_NAME: 'events-reconcile-test',
  GIT_COMMITTER_EMAIL: 'events-reconcile-test@example.invalid',
};
const temporaryRepositories: string[] = [];

afterEach(() => {
  for (const repository of temporaryRepositories.splice(0)) {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    env: TEST_GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeJson(repository: string, relativeParts: string[], value: unknown) {
  const file = path.join(repository, ...relativeParts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function daysAhead(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function baseEvent() {
  return {
    id: 'fantasia:lanterna',
    title: 'Notte delle Campanelle',
    startDate: daysAhead(5),
    endDate: daysAhead(5),
    comune: 'Borgo Sognato',
    canton: 'TI',
    sourceKey: 'fantasia',
    sourceName: 'Fantasia Agenda',
    url: 'https://fantasia.example/events/lanterna',
    description: 'Una serata narrativa nel borgo con musica e installazioni luminose.',
  };
}

function crawlEvent() {
  return {
    id: 'fantasia:aurora',
    title: 'Fiera delle Nebbie Azzurre',
    startDate: daysAhead(7),
    endDate: daysAhead(7),
    comune: 'Valle Immaginata',
    canton: 'TI',
    sourceKey: 'fantasia',
    sourceName: 'Fantasia Agenda',
    url: 'https://fantasia.example/events/aurora',
    description: 'Un incontro di artigiani e narratori nella piazza della valle.',
  };
}

function rewrittenItalianDescription() {
  return 'descrizione aggiornata dell evento nel luogo indicato. seconda frase informativa per il pubblico locale.';
}

function rewriteCache() {
  const event = baseEvent();
  const hash = sourceDescriptionHash(event);
  const descriptions = {
    it: rewrittenItalianDescription(),
    en: 'updated event description for the listed venue. second factual sentence for the local audience.',
    de: 'aktualisierte Veranstaltungsbeschreibung am genannten Ort. zweiter sachlicher Satz für das lokale Publikum.',
    fr: 'description actualisee de l evenement dans le lieu indique. seconde phrase factuelle pour le public local.',
  };
  return {
    schemaVersion: 2,
    entries: {
      [`${event.id}::${hash}`]: {
        id: event.id,
        sourceDescriptionHash: hash,
        model: EVENT_DESCRIPTION_REWRITE_MODEL,
        promptVersion: EVENT_DESCRIPTION_PROMPT_VERSION,
        rewrittenAt: new Date().toISOString(),
        description: descriptions.it,
        descriptionByLocale: descriptions,
      },
    },
  };
}

function writeSlice(repository: string, events: unknown[]) {
  writeJson(repository, ['data', 'events', 'by-source', 'fantasia.json'], {
    schemaVersion: 1,
    sourceKey: 'fantasia',
    assembledAt: new Date().toISOString(),
    events,
  });
}

function assembleRepository(repository: string) {
  const assemblerUrl = pathToFileURL(path.join(ROOT, 'scripts/assemble-events-dataset.mjs')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { assemble } from ${JSON.stringify(assemblerUrl)};
    assemble({
      sliceDir: process.env.EVENT_TEST_SLICE_DIR,
      datasetPath: process.env.EVENT_TEST_DATASET_PATH,
      rewriteCachePath: process.env.EVENT_TEST_REWRITE_CACHE_PATH,
    });
  `], {
    cwd: repository,
    env: {
      ...TEST_GIT_ENV,
      EVENT_TEST_SLICE_DIR: path.join(repository, 'data', 'events', 'by-source'),
      EVENT_TEST_DATASET_PATH: path.join(repository, 'data', 'events.json'),
      EVENT_TEST_REWRITE_CACHE_PATH: path.join(repository, 'data', 'events-description-rewrites.json'),
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || 'fixture assembly failed');
}

function commitAll(repository: string, message: string) {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-q', '-m', message]);
  return git(repository, ['rev-parse', 'HEAD']);
}

function createScenario(refreshRole: 'crawl' | 'rewrite') {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'events-derived-reconcile-test-'));
  temporaryRepositories.push(repository);
  git(repository, ['init', '-q', '-b', 'main']);
  git(repository, ['config', 'user.name', 'events-reconcile-test']);
  git(repository, ['config', 'user.email', 'events-reconcile-test@example.invalid']);

  const original = baseEvent();
  writeSlice(repository, [original]);
  writeJson(repository, ['data', 'events-description-rewrites.json'], { schemaVersion: 2, entries: {} });
  writeJson(repository, ['data', 'events-geocode-cache.json'], {});
  writeJson(repository, ['data', 'events-translation-cache.json'], {});
  assembleRepository(repository);
  const base = commitAll(repository, 'base events inputs');

  git(repository, ['checkout', '-q', '-b', 'refresh']);
  if (refreshRole === 'crawl') {
    writeSlice(repository, [original, crawlEvent()]);
    writeJson(repository, ['data', 'events-geocode-cache.json'], { crawl: { place: 'Valle Immaginata' } });
    writeJson(repository, ['data', 'events-translation-cache.json'], { crawl: { locale: 'it' } });
  } else {
    writeJson(repository, ['data', 'events-description-rewrites.json'], rewriteCache());
  }
  assembleRepository(repository);
  const refresh = commitAll(repository, `${refreshRole} refresh in progress`);

  git(repository, ['checkout', '-q', 'main']);
  if (refreshRole === 'crawl') {
    writeJson(repository, ['data', 'events-description-rewrites.json'], rewriteCache());
    // These two concurrent cache writes reproduce the cache conflicts present
    // in the incident alongside the derived dataset conflict.
    writeJson(repository, ['data', 'events-geocode-cache.json'], { main: { place: 'Borgo Sognato' } });
    writeJson(repository, ['data', 'events-translation-cache.json'], { main: { locale: 'it' } });
  } else {
    writeSlice(repository, [original, crawlEvent()]);
    writeJson(repository, ['data', 'events-geocode-cache.json'], { main: { place: 'Valle Immaginata' } });
    writeJson(repository, ['data', 'events-translation-cache.json'], { main: { locale: 'it' } });
  }
  assembleRepository(repository);
  const main = commitAll(repository, `main ${refreshRole === 'crawl' ? 'rewrite' : 'crawl'} arrives`);

  git(repository, ['checkout', '-q', 'refresh']);
  return { repository, base, main, refresh };
}

function runReconciler(scenario: ReturnType<typeof createScenario>) {
  return spawnSync(process.execPath, [
    RECONCILE_SCRIPT,
    '--base', scenario.base,
    '--main', scenario.main,
    '--message', 'reconcile events test',
  ], {
    cwd: scenario.repository,
    env: {
      ...TEST_GIT_ENV,
      EVENTS_DERIVED_DATASET_RECONCILIATION: 'events',
      RECONCILE_SOURCE_ROOT: ROOT,
      GIT_NO_LAZY_FETCH: '1',
    },
    encoding: 'utf8',
  });
}

function dataset(repository: string) {
  return JSON.parse(git(repository, ['show', 'HEAD:data/events.json'])) as {
    events: Array<Record<string, unknown>>;
  };
}

describe('events derived dataset reconciliation', () => {
  it('publishes a crawl with both its new event and a rewrite that arrived on main', () => {
    const scenario = createScenario('crawl');
    const result = runReconciler(scenario);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('regenerated data/events.json, public/data/events.json');
    const events = dataset(scenario.repository).events;
    expect(events.map((event) => event.id)).toEqual(['fantasia:lanterna', 'fantasia:aurora']);
    expect(events.find((event) => event.id === 'fantasia:lanterna')?.description)
      .toBe(rewrittenItalianDescription());
    expect(JSON.parse(git(scenario.repository, ['show', 'HEAD:public/data/events.json']))).toEqual(dataset(scenario.repository));
    expect(git(scenario.repository, ['show', 'HEAD:data/events-geocode-cache.json'])).toContain('crawl');
    expect(git(scenario.repository, ['show', 'HEAD:data/events-geocode-cache.json'])).toContain('main');
  });

  it('publishes a rewrite with both the rewrite and a crawl that arrived on main', () => {
    const scenario = createScenario('rewrite');
    const result = runReconciler(scenario);

    expect(result.status).toBe(0);
    const events = dataset(scenario.repository).events;
    expect(events.map((event) => event.id)).toEqual(['fantasia:lanterna', 'fantasia:aurora']);
    expect(events.find((event) => event.id === 'fantasia:lanterna')?.description)
      .toBe(rewrittenItalianDescription());
    expect(JSON.parse(git(scenario.repository, ['show', 'HEAD:public/data/events.json']))).toEqual(dataset(scenario.repository));
  });

  it('names a conflict the opt-in does not cover, and leaves the branch where it was', () => {
    const scenario = createScenario('crawl');
    // Both sides also change a file that is neither a cache nor the dataset.
    git(scenario.repository, ['checkout', '-q', '--detach', scenario.main]);
    writeJson(scenario.repository, ['data', 'unexpected.json'], { side: 'main' });
    const main = commitAll(scenario.repository, 'main also changes an unrelated file');
    git(scenario.repository, ['checkout', '-q', 'refresh']);
    writeJson(scenario.repository, ['data', 'unexpected.json'], { side: 'refresh' });
    const refresh = commitAll(scenario.repository, 'refresh also changes an unrelated file');

    const result = runReconciler({ ...scenario, main, refresh });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Unresolved refresh conflict outside event caches or derived datasets: data/unexpected.json',
    );
    // The dataset conflicts too, but the opt-in resolves it: it is not named.
    expect(result.stderr).not.toContain('events.json');
    expect(git(scenario.repository, ['rev-parse', 'HEAD'])).toBe(refresh);
  });

  it('refuses the same conflict for a publisher that did not opt in, naming only what blocks it', () => {
    const scenario = createScenario('crawl');
    const result = spawnSync(process.execPath, [
      RECONCILE_SCRIPT,
      '--base', scenario.base,
      '--main', scenario.main,
      '--message', 'reconcile events test',
    ], {
      cwd: scenario.repository,
      env: { ...TEST_GIT_ENV, GIT_NO_LAZY_FETCH: '1' },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    // The caches conflict too, and the reconciler can merge them: the message
    // lists the two files that stop it, not every file in conflict.
    expect(result.stderr).toContain(
      'Unresolved refresh conflict outside event caches: data/events.json, public/data/events.json',
    );
    expect(result.stderr).not.toContain('data/events-geocode-cache.json');
    // Nothing was committed: the refresh branch is where it was.
    expect(git(scenario.repository, ['rev-parse', 'HEAD'])).toBe(scenario.refresh);
  });
});

describe('shared blob reader of the refresh reconcilers', () => {
  const readerUrl = pathToFileURL(path.join(ROOT, 'scripts/lib/read-git-blob.mjs')).href;

  function readIfPresent(repository: string, ref: string, file: string) {
    const script = `import { readGitBlobIfPresent } from ${JSON.stringify(readerUrl)};`
      + ` const value = readGitBlobIfPresent(process.argv[1], process.argv[2]);`
      + ` process.stdout.write(JSON.stringify({ value }));`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script, ref, file], {
      cwd: repository, env: { ...TEST_GIT_ENV, GIT_NO_LAZY_FETCH: '1' }, encoding: 'utf8',
    });
  }

  it('reads a missing path as absent and an unreadable object as an error', () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-blob-reader-test-'));
    temporaryRepositories.push(repository);
    git(repository, ['init', '-q', '-b', 'main']);
    writeJson(repository, ['cache', 'kept.json'], { side: 'stable' });
    const head = commitAll(repository, 'one cached file');

    const present = readIfPresent(repository, head, 'cache/kept.json');
    expect(present.status, present.stderr).toBe(0);
    expect(JSON.parse(JSON.parse(present.stdout).value)).toEqual({ side: 'stable' });

    // A path one side never had: a normal add/delete state of a three-way merge.
    const absent = readIfPresent(repository, head, 'cache/never-there.json');
    expect(absent.status, absent.stderr).toBe(0);
    expect(JSON.parse(absent.stdout)).toEqual({ value: null });

    // The tree still lists the file, but its object is gone from the store:
    // what a partial clone looks like when a blob cannot be fetched.
    const oid = git(repository, ['rev-parse', `${head}:cache/kept.json`]);
    fs.rmSync(path.join(repository, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
    const unreadable = readIfPresent(repository, head, 'cache/kept.json');
    expect(unreadable.status).not.toBe(0);
    expect(unreadable.stdout).toBe('');
  });
});
