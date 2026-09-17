import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptPath = process.env.GIT_PUSH_WITH_RETRY_SCRIPT
  ?? fileURLToPath(new URL('../scripts/lib/git-push-with-retry.sh', import.meta.url));

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function command(commandName, args, cwd, env = {}) {
  const result = spawnSync(commandName, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function configureIdentity(cwd) {
  git(cwd, ['config', 'user.name', 'Test Runner']);
  git(cwd, ['config', 'user.email', 'test@example.invalid']);
}

async function setupScenario({
  overlappingWip = false,
  deletedWip = false,
  stagedOnlyWip = false,
  stagedOnlyAddedWip = false,
  untrackedWip = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'git-push-with-retry-'));
  const bare = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const local = join(root, 'local');
  const updater = join(root, 'updater');
  const bin = join(root, 'bin');

  git(root, ['init', '--bare', '--initial-branch=main', bare]);
  git(root, ['init', '--initial-branch=main', seed]);
  configureIdentity(seed);
  await writeFile(join(seed, 'conflict.txt'), 'base\n');
  await writeFile(join(seed, 'wip.txt'), 'base\n');
  const seedFiles = ['conflict.txt', 'wip.txt'];
  if (stagedOnlyWip) {
    await writeFile(join(seed, 'staged-only.txt'), 'base\n');
    seedFiles.push('staged-only.txt');
  }
  git(seed, ['add', ...seedFiles]);
  git(seed, ['commit', '-m', 'base']);
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', 'origin', 'main']);

  git(root, ['clone', '--branch', 'main', bare, local]);
  git(root, ['clone', '--branch', 'main', bare, updater]);
  configureIdentity(local);
  configureIdentity(updater);

  await writeFile(join(local, 'conflict.txt'), 'local commit\n');
  git(local, ['add', 'conflict.txt']);
  git(local, ['commit', '-m', 'local change']);
  await writeFile(join(local, 'wip.txt'), 'dirty WIP\n');
  if (deletedWip) {
    await rm(join(local, 'wip.txt'));
  }
  if (overlappingWip) {
    await writeFile(join(local, 'conflict.txt'), 'dirty WIP conflict\n');
  }
  if (stagedOnlyWip) {
    await rm(join(local, 'staged-only.txt'));
    await symlink('staged-only-target', join(local, 'staged-only.txt'));
    git(local, ['add', 'staged-only.txt']);
    await rm(join(local, 'staged-only.txt'));
    await writeFile(join(local, 'staged-only.txt'), 'base\n');
  }
  if (stagedOnlyAddedWip) {
    await writeFile(join(local, 'staged-only-added.txt'), 'staged-only WIP\n');
    git(local, ['add', 'staged-only-added.txt']);
    await rm(join(local, 'staged-only-added.txt'));
  }
  if (untrackedWip) {
    await writeFile(join(local, 'untracked-wip.txt'), 'untracked WIP\n');
  }

  await writeFile(join(updater, 'conflict.txt'), 'remote change\n');
  git(updater, ['add', 'conflict.txt']);
  git(updater, ['commit', '-m', 'remote change']);
  git(updater, ['push', 'origin', 'main']);

  await mkdir(bin);
  await writeFile(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  await chmod(join(bin, 'sleep'), 0o755);

  return {
    root,
    local,
    sleepPath: bin,
    file(name) {
      return join(local, name);
    },
  };
}

function invoke(scenario, args) {
  return command(
    'bash',
    [scriptPath, '--branch', 'main', '--max-attempts', '2', '--stash-dirty', ...args],
    scenario.local,
    { PATH: `${scenario.sleepPath}:${process.env.PATH}` },
  );
}

async function assertWipRestored(scenario) {
  assert.equal(await readFile(scenario.file('wip.txt'), 'utf8'), 'dirty WIP\n');
  assert.equal(git(scenario.local, ['stash', 'list']), '');
}

test('no resolver restores non-overlapping WIP after rebase abort', async () => {
  const scenario = await setupScenario();
  try {
    const result = invoke(scenario, []);

    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Rebase conflict and no resolver provided/);
    await assertWipRestored(scenario);
    assert.equal(await readFile(scenario.file('conflict.txt'), 'utf8'), 'local commit\n');
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test('regenerate path restores WIP after abort and hard reset', async () => {
  const scenario = await setupScenario();
  const regenerate = join(scenario.root, 'regenerate.sh');
  try {
    await writeFile(
      regenerate,
      '#!/bin/sh\nprintf \'regenerated\\n\' > regenerate.txt\ngit add regenerate.txt\n',
    );
    await chmod(regenerate, 0o755);

    const result = invoke(scenario, ['--regenerate-cmd', `bash '${regenerate}'`]);

    assert.equal(result.status, 0, result.output);
    await assertWipRestored(scenario);
    assert.equal(await readFile(scenario.file('regenerate.txt'), 'utf8'), 'regenerated\n');
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test('in-place resolver sees WIP and restores it if the resolver fails', async () => {
  const scenario = await setupScenario();
  const resolver = join(scenario.root, 'resolver.sh');
  try {
    await writeFile(
      resolver,
      '#!/bin/sh\nset -eu\ntest "$(cat wip.txt)" = "dirty WIP"\nexit 1\n',
    );
    await chmod(resolver, 0o755);

    const result = invoke(scenario, ['--in-place-resolver-cmd', `bash '${resolver}'`]);

    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /In-place conflict resolver failed/);
    await assertWipRestored(scenario);
    assert.equal(await readFile(scenario.file('conflict.txt'), 'utf8'), 'local commit\n');
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test('in-place resolver can resolve the rebase while WIP is applied', async () => {
  const scenario = await setupScenario();
  const resolver = join(scenario.root, 'resolver.sh');
  try {
    await writeFile(
      resolver,
      '#!/bin/sh\nset -eu\ntest "$(cat wip.txt)" = "dirty WIP"\nprintf \'resolved\\n\' > conflict.txt\ngit add conflict.txt\n',
    );
    await chmod(resolver, 0o755);

    const result = invoke(scenario, ['--in-place-resolver-cmd', `bash '${resolver}'`]);

    assert.equal(result.status, 0, result.output);
    await assertWipRestored(scenario);
    assert.equal(await readFile(scenario.file('conflict.txt'), 'utf8'), 'resolved\n');
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test('in-place resolver preserves WIP staged only in the original stash index', async () => {
  const scenario = await setupScenario({ stagedOnlyWip: true });
  const resolver = join(scenario.root, 'resolver.sh');
  try {
    await writeFile(
      resolver,
      "#!/bin/sh\nset -eu\ntest -L staged-only.txt\ntest \"$(readlink staged-only.txt)\" = \"staged-only-target\"\nprintf 'resolved\\n' > conflict.txt\ngit add conflict.txt\n",
    );
    await chmod(resolver, 0o755);

    const result = invoke(scenario, ['--in-place-resolver-cmd', `bash '${resolver}'`]);

    assert.equal(result.status, 0, result.output);
    await assertWipRestored(scenario);
    assert.equal(await readlink(scenario.file('staged-only.txt')), 'staged-only-target');
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test('in-place resolver restores a never-committed staged-only WIP path', async () => {
  const scenario = await setupScenario({ stagedOnlyAddedWip: true });
  const resolver = join(scenario.root, 'resolver.sh');
  try {
    await writeFile(
      resolver,
      "#!/bin/sh\nset -eu\ntest \"$(cat staged-only-added.txt)\" = \"staged-only WIP\"\ntest -z \"$(git ls-tree -r --name-only 'stash@{0}^1' -- staged-only-added.txt)\"\ntest -n \"$(git ls-tree -r --name-only 'stash@{0}^2' -- staged-only-added.txt)\"\nprintf 'resolved\\n' > conflict.txt\ngit add -A\n",
    );
    await chmod(resolver, 0o755);

    const result = invoke(scenario, ['--in-place-resolver-cmd', `bash '${resolver}'`]);

    assert.equal(result.status, 0, result.output);
    await assertWipRestored(scenario);
    assert.equal(await readFile(scenario.file('staged-only-added.txt'), 'utf8'), 'staged-only WIP\n');
    const committedWip = command(
      'git',
      ['cat-file', '-e', 'HEAD:staged-only-added.txt'],
      scenario.local,
    );
    assert.notEqual(committedWip.status, 0, committedWip.output);
    assert.match(
      command('git', ['status', '--porcelain', '--', 'staged-only-added.txt'], scenario.local).output,
      /\?\? staged-only-added\.txt/,
    );
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test('in-place resolver leaves an unstaged untracked WIP path available', async () => {
  const scenario = await setupScenario({ untrackedWip: true });
  const resolver = join(scenario.root, 'resolver.sh');
  try {
    await writeFile(
      resolver,
      "#!/bin/sh\nset -eu\ntest \"$(cat untracked-wip.txt)\" = \"untracked WIP\"\nprintf 'resolved\\n' > conflict.txt\ngit add conflict.txt\n",
    );
    await chmod(resolver, 0o755);

    const result = invoke(scenario, ['--in-place-resolver-cmd', `bash '${resolver}'`]);

    assert.equal(result.status, 0, result.output);
    await assertWipRestored(scenario);
    assert.equal(await readFile(scenario.file('untracked-wip.txt'), 'utf8'), 'untracked WIP\n');
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test('in-place resolver keeps broadly staged original WIP out of the rebased commit', async () => {
  const scenario = await setupScenario();
  const resolver = join(scenario.root, 'resolver.sh');
  try {
    await writeFile(
      resolver,
      "#!/bin/sh\nset -eu\ntest \"$(cat wip.txt)\" = \"dirty WIP\"\nprintf 'resolved\\n' > conflict.txt\ngit add -A\n",
    );
    await chmod(resolver, 0o755);

    const result = invoke(scenario, ['--in-place-resolver-cmd', `bash '${resolver}'`]);

    assert.equal(result.status, 0, result.output);
    await assertWipRestored(scenario);
    assert.equal(git(scenario.local, ['show', 'HEAD:wip.txt']), 'base');
    assert.equal(await readFile(scenario.file('conflict.txt'), 'utf8'), 'resolved\n');
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test('in-place resolver keeps a broadly staged WIP deletion out of the rebased commit', async () => {
  const scenario = await setupScenario({ deletedWip: true });
  const resolver = join(scenario.root, 'resolver.sh');
  try {
    await writeFile(
      resolver,
      "#!/bin/sh\nset -eu\ntest ! -e wip.txt\nprintf 'resolved\\n' > conflict.txt\ngit add -A\n",
    );
    await chmod(resolver, 0o755);

    const result = invoke(scenario, ['--in-place-resolver-cmd', `bash '${resolver}'`]);

    assert.equal(result.status, 0, result.output);
    assert.equal(git(scenario.local, ['show', 'HEAD:wip.txt']), 'base');
    assert.equal(await readFile(scenario.file('conflict.txt'), 'utf8'), 'resolved\n');
    assert.equal(command('test', ['-e', scenario.file('wip.txt')]).status, 1);
    assert.equal(git(scenario.local, ['stash', 'list']), '');
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test('in-place resolver preserves staged fixes when WIP overlaps the conflict', async () => {
  const scenario = await setupScenario({ overlappingWip: true });
  const resolver = join(scenario.root, 'resolver.sh');
  const preCommitHook = join(scenario.local, '.git', 'hooks', 'pre-commit');
  try {
    await writeFile(
      resolver,
      '#!/bin/sh\nset -eu\ntest "$(cat conflict.txt)" = "dirty WIP conflict"\nprintf \'resolved\\n\' > conflict.txt\ngit add conflict.txt\n',
    );
    await chmod(resolver, 0o755);
    await writeFile(
      preCommitHook,
      '#!/bin/sh\nset -eu\ngit diff --cached --name-only | grep -Fx conflict.txt >/dev/null\n',
    );
    await chmod(preCommitHook, 0o755);

    const result = invoke(scenario, ['--in-place-resolver-cmd', `bash '${resolver}'`]);

    assert.equal(result.status, 0, result.output);
    await assertWipRestored(scenario);
    assert.equal(await readFile(scenario.file('conflict.txt'), 'utf8'), 'resolved\n');
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});
