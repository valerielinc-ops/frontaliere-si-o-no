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

function laterCrawlEvent() {
  return {
    id: 'fantasia:brina',
    title: 'Mercato della Brina Dorata',
    startDate: daysAhead(9),
    endDate: daysAhead(9),
    comune: 'Poggio Inventato',
    canton: 'TI',
    sourceKey: 'fantasia',
    sourceName: 'Fantasia Agenda',
    url: 'https://fantasia.example/events/brina',
    description: 'Un mercato serale con banchi di artigiani e letture ad alta voce.',
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

const SLICE_PARTS = ['data', 'events', 'by-source', 'fantasia.json'];
const CHECKPOINT_PARTS = ['data', 'events', 'checkpoints', 'fantasia.json'];
const SLICE_IN_TREE = SLICE_PARTS.join('/');
const CHECKPOINT_IN_TREE = CHECKPOINT_PARTS.join('/');

function writeCheckpoint(repository: string, nextIndex: number) {
  writeJson(repository, CHECKPOINT_PARTS, { nextIndex, updatedAt: new Date().toISOString() });
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

function runReconciler(
  scenario: { repository: string; base: string; main: string },
  extraEnv: Record<string, string> = {},
) {
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
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

function runReconcilerInDisposableWorktree(
  scenario: { repository: string; base: string; main: string; refresh: string },
  extraEnv: Record<string, string> = {},
) {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'events-refresh-preflight-test-'));
  const probe = path.join(probeRoot, 'worktree');
  try {
    git(scenario.repository, ['worktree', 'add', '-q', '--detach', '--no-checkout', probe, scenario.refresh]);
    const result = runReconciler({ ...scenario, repository: probe }, {
      EVENTS_REFRESH_CARRIED_REF: '',
      ...extraEnv,
    });
    return {
      result,
      refreshRef: git(scenario.repository, ['rev-parse', 'refs/heads/refresh']),
      mainRef: git(scenario.repository, ['rev-parse', 'refs/heads/main']),
      probedHead: git(probe, ['rev-parse', 'HEAD']),
      probedSlice: git(probe, ['show', `HEAD:${SLICE_IN_TREE}`]),
      refresh: scenario.refresh,
      main: scenario.main,
      repository: scenario.repository,
      probe,
    };
  } finally {
    git(scenario.repository, ['worktree', 'remove', '--force', probe]);
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

const CARRIED_REF = 'refs/crawl-events/carried-forward';

// The run of 2026-10-08: the crawl restores the slices and checkpoints of the
// pending refresh, that refresh is merged into main while the crawl is still
// running, and the publisher then meets main with a branch cut from the commit
// the job checked out.
function createCarriedScenario({ editedOnMain = false, droppedByCrawl = false } = {}) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'events-carried-reconcile-test-'));
  temporaryRepositories.push(repository);
  git(repository, ['init', '-q', '-b', 'main']);
  git(repository, ['config', 'user.name', 'events-reconcile-test']);
  git(repository, ['config', 'user.email', 'events-reconcile-test@example.invalid']);

  const original = baseEvent();
  writeSlice(repository, [original]);
  writeCheckpoint(repository, 10);
  writeJson(repository, ['data', 'events-description-rewrites.json'], { schemaVersion: 2, entries: {} });
  writeJson(repository, ['data', 'events-geocode-cache.json'], {});
  writeJson(repository, ['data', 'events-translation-cache.json'], {});
  assembleRepository(repository);
  const base = commitAll(repository, 'what the job checked out');

  git(repository, ['checkout', '-q', '-b', 'pending']);
  writeSlice(repository, [original, crawlEvent()]);
  writeCheckpoint(repository, 20);
  assembleRepository(repository);
  const carried = commitAll(repository, 'pending refresh of the previous crawl');
  git(repository, ['update-ref', CARRIED_REF, carried]);

  // This crawl: the job's checkout, the pending source state restored on top
  // of it, then one more event and a checkpoint further on.
  git(repository, ['checkout', '-q', '-b', 'refresh', base]);
  git(repository, ['restore', `--source=${carried}`, '--', SLICE_IN_TREE, CHECKPOINT_IN_TREE]);
  writeSlice(repository, [original, crawlEvent(), laterCrawlEvent()]);
  writeCheckpoint(repository, 30);
  // No crawler removes a checkpoint today; a branch that did would not be
  // carrying that file on.
  if (droppedByCrawl) fs.rmSync(path.join(repository, ...CHECKPOINT_PARTS));
  assembleRepository(repository);
  const refresh = commitAll(repository, 'this crawl, on top of the pending refresh');

  // Meanwhile the pending refresh lands on main, byte for byte, next to a
  // description rewrite that makes the derived dataset conflict as well.
  git(repository, ['checkout', '-q', 'main']);
  git(repository, ['restore', `--source=${carried}`, '--', SLICE_IN_TREE, CHECKPOINT_IN_TREE]);
  if (editedOnMain) {
    // A second writer of the slices (the licence audit) drops a field after
    // the merge and leaves the slice timestamp alone.
    const slice = JSON.parse(fs.readFileSync(path.join(repository, ...SLICE_PARTS), 'utf8'));
    for (const event of slice.events) delete event.description;
    writeJson(repository, SLICE_PARTS, slice);
  }
  writeJson(repository, ['data', 'events-description-rewrites.json'], rewriteCache());
  assembleRepository(repository);
  const main = commitAll(repository, 'the pending refresh is merged while the crawl runs');

  git(repository, ['checkout', '-q', 'refresh']);
  return { repository, base, main, refresh, carried };
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

describe('events source state carried over from a pending refresh', () => {
  const conflictPrefix = 'Unresolved refresh conflict outside event caches or derived datasets: ';
  const notContinuation = 'Not a continuation of the refresh this crawl started from '
    + '(main holds something else, or this branch dropped the file): ';

  it('continues the slices and checkpoints of a pending refresh merged while the crawl ran', () => {
    const scenario = createCarriedScenario();
    const result = runReconciler(scenario, { EVENTS_REFRESH_CARRIED_REF: CARRIED_REF });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('continued 2 source state file(s) from the carried refresh');
    expect(result.stdout).toContain('resolved 0 cache conflict(s)');
    expect(result.stdout).toContain('regenerated data/events.json, public/data/events.json');

    // The source state is this crawl's, untouched: no merge of two slices.
    for (const file of [SLICE_IN_TREE, CHECKPOINT_IN_TREE]) {
      expect(git(scenario.repository, ['rev-parse', `HEAD:${file}`]))
        .toBe(git(scenario.repository, ['rev-parse', `${scenario.refresh}:${file}`]));
    }
    expect(JSON.parse(git(scenario.repository, ['show', `HEAD:${CHECKPOINT_IN_TREE}`])).nextIndex).toBe(30);

    // The dataset comes from that source state and from the rewrite on main.
    const events = dataset(scenario.repository).events;
    expect(events.map((event) => event.id)).toEqual(['fantasia:lanterna', 'fantasia:aurora', 'fantasia:brina']);
    expect(events.find((event) => event.id === 'fantasia:lanterna')?.description)
      .toBe(rewrittenItalianDescription());
    expect(git(scenario.repository, ['show', 'HEAD:data/events.json'])).not.toContain('<<<<<<<');
    expect(git(scenario.repository, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').slice(1))
      .toEqual([scenario.refresh, scenario.main]);
  });

  it('takes the starting refresh as a commit id as well as a ref name', () => {
    const scenario = createCarriedScenario();
    const result = runReconciler(scenario, { EVENTS_REFRESH_CARRIED_REF: scenario.carried });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('continued 2 source state file(s) from the carried refresh');
  });

  it('stops when no starting refresh was recorded, and says that is why', () => {
    const scenario = createCarriedScenario();
    const result = runReconciler(scenario);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${conflictPrefix}${SLICE_IN_TREE}, ${CHECKPOINT_IN_TREE}`);
    expect(result.stderr).toContain('No starting refresh was recorded (EVENTS_REFRESH_CARRIED_REF)');
    expect(git(scenario.repository, ['rev-parse', 'HEAD'])).toBe(scenario.refresh);
  });

  it('stops when main holds something other than the state the crawl started from', () => {
    const scenario = createCarriedScenario({ editedOnMain: true });
    const result = runReconciler(scenario, { EVENTS_REFRESH_CARRIED_REF: CARRIED_REF });

    expect(result.status).toBe(1);
    // The checkpoint on main is still the carried one, so only the slice blocks.
    expect(result.stderr).toContain(`${conflictPrefix}${SLICE_IN_TREE}\n`);
    expect(result.stderr).toContain(`${notContinuation}${SLICE_IN_TREE}`);
    expect(result.stderr).not.toContain(CHECKPOINT_IN_TREE);
    expect(git(scenario.repository, ['rev-parse', 'HEAD'])).toBe(scenario.refresh);
  });

  it('stops on a file the crawl removed, even when main still holds the starting state', () => {
    const scenario = createCarriedScenario({ droppedByCrawl: true });
    const result = runReconciler(scenario, { EVENTS_REFRESH_CARRIED_REF: CARRIED_REF });

    expect(result.status).toBe(1);
    // The slice is a continuation; the checkpoint has nothing to carry on.
    expect(result.stderr).toContain(`${conflictPrefix}${CHECKPOINT_IN_TREE}\n`);
    expect(result.stderr).toContain(`${notContinuation}${CHECKPOINT_IN_TREE}`);
    expect(result.stderr).not.toContain(SLICE_IN_TREE);
    expect(git(scenario.repository, ['rev-parse', 'HEAD'])).toBe(scenario.refresh);
  });

  it('finds the starting refresh from the worktree the publisher runs in', () => {
    // open-data-refresh-pr.sh reconciles in a worktree it adds with --detach
    // --no-checkout: the ref the crawl step wrote has to resolve there, and
    // nothing may depend on a file being on disk.
    const scenario = createCarriedScenario();
    const publisher = fs.mkdtempSync(path.join(os.tmpdir(), 'events-carried-publisher-test-'));
    temporaryRepositories.push(publisher);
    git(scenario.repository, ['worktree', 'add', '-q', '--detach', '--no-checkout', publisher, scenario.refresh]);
    expect(fs.readdirSync(publisher)).toEqual(['.git']);

    const result = runReconciler({ ...scenario, repository: publisher }, { EVENTS_REFRESH_CARRIED_REF: CARRIED_REF });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('continued 2 source state file(s) from the carried refresh');
    for (const file of [SLICE_IN_TREE, CHECKPOINT_IN_TREE]) {
      expect(git(publisher, ['rev-parse', `HEAD:${file}`]))
        .toBe(git(publisher, ['rev-parse', `${scenario.refresh}:${file}`]));
    }
    expect(dataset(publisher).events.map((event) => event.id))
      .toEqual(['fantasia:lanterna', 'fantasia:aurora', 'fantasia:brina']);
    // Only the publisher's detached HEAD moved; the crawl's branch did not.
    expect(git(scenario.repository, ['rev-parse', 'refs/heads/refresh'])).toBe(scenario.refresh);
  });

  it('refuses a starting refresh that is not a commit in the checkout', () => {
    const scenario = createCarriedScenario();
    const result = runReconciler(scenario, { EVENTS_REFRESH_CARRIED_REF: 'refs/crawl-events/never-written' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'EVENTS_REFRESH_CARRIED_REF names refs/crawl-events/never-written, which is not a commit in this checkout',
    );
    expect(git(scenario.repository, ['rev-parse', 'HEAD'])).toBe(scenario.refresh);
  });

  it('leaves a continued slice alone for a publisher that carried nothing over', () => {
    // Without the variable the rule does not exist: the cache-only and the
    // derived-dataset scenarios above behave exactly as before.
    const scenario = createScenario('crawl');
    const result = runReconciler(scenario);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('continued');
  });

  it('records the starting refresh in the crawl before restoring from it', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'crawl-events.yml'), 'utf8');
    const start = workflow.indexOf('- name: Carry forward pending events refresh PR');
    const end = workflow.indexOf('- name: Validate targeted source inputs');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step = workflow.slice(start, end);

    const fetched = step.indexOf('git fetch --no-tags --depth=1');
    const disposableWorktree = step.indexOf('git worktree add --detach --no-checkout');
    const preflight = step.indexOf('reconcile-data-refresh-main.mjs');
    const sourceConflict = step.indexOf('Not a continuation of the refresh this crawl started from');
    const recorded = step.indexOf(`git update-ref ${CARRIED_REF}`);
    const exported = step.indexOf(`echo "EVENTS_REFRESH_CARRIED_REF=${CARRIED_REF}" >> "$GITHUB_ENV"`);
    const restored = step.indexOf('bash scripts/lib/restore-stable-refresh-files.sh');
    expect(fetched).toBeGreaterThan(-1);
    expect(disposableWorktree).toBeGreaterThan(fetched);
    expect(preflight).toBeGreaterThan(disposableWorktree);
    expect(sourceConflict).toBeGreaterThan(preflight);
    expect(recorded).toBeGreaterThan(sourceConflict);
    expect(exported).toBeGreaterThan(recorded);
    expect(restored).toBeGreaterThan(exported);
    expect(step).toContain('No starting refresh was recorded \\(EVENTS_REFRESH_CARRIED_REF\\)');
    expect(step).toContain("GIT_AUTHOR_NAME='frontaliere-automation[bot]'");
    expect(step).toContain("GIT_COMMITTER_EMAIL='296434481+frontaliere-automation[bot]@users.noreply.github.com'");
    expect(step).toContain('git checkout --detach "$main_sha"');
    expect(step).toContain('starting this crawl from current main on a new branch');
    expect(step).toContain('EVENTS_REFRESH_REQUIRE_NEW_BRANCH=true');
    expect(step).toContain('EVENTS_REFRESH_BRANCH=${branch}');
    // The ref is written from the commit just fetched, not from a moving name.
    expect(step).toContain('git update-ref refs/crawl-events/carried-forward "$carry_sha"');
    expect(step.indexOf('refs/crawl-events/carried-forward', restored)).toBeGreaterThan(restored);
  });

  it('preflights cache/derived conflicts in a disposable worktree without moving the stable branch', () => {
    const scenario = createScenario('crawl');
    const { result, refreshRef, mainRef, probedHead, refresh, main } = runReconcilerInDisposableWorktree(scenario);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('regenerated data/events.json, public/data/events.json');
    expect(refreshRef).toBe(refresh);
    expect(mainRef).toBe(main);
    expect(probedHead).not.toBe(refresh);
  });

  it('carries source state already advanced on main when the pending refresh does not conflict', () => {
    const scenario = createScenario('rewrite');
    const { result, probedSlice, refreshRef, mainRef, refresh, main } = runReconcilerInDisposableWorktree(scenario);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(probedSlice).events.map((event: { id: string }) => event.id))
      .toEqual(['fantasia:lanterna', 'fantasia:aurora']);
    expect(refreshRef).toBe(refresh);
    expect(mainRef).toBe(main);
  });

  it('preflight rejects an unreconcilable source conflict while preserving the pending branch', () => {
    const scenario = createCarriedScenario({ editedOnMain: true });
    const { result, refreshRef, mainRef, probedHead, refresh, main } = runReconcilerInDisposableWorktree(scenario);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Unresolved refresh conflict outside event caches or derived datasets: data/events/by-source/fantasia.json',
    );
    expect(result.stderr).toContain('No starting refresh was recorded (EVENTS_REFRESH_CARRIED_REF)');
    expect(refreshRef).toBe(refresh);
    expect(mainRef).toBe(main);
    expect(probedHead).toBe(refresh);
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
