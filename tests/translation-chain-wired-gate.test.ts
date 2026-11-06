/**
 * The gate that keeps the translation v2 chain's orphan surface from growing
 * (#7096).
 *
 * The chain is a complete, tested state machine that nothing runs. Tests are
 * exactly why that stayed invisible, so the gate must not be fooled by a test
 * importing a module, and it must not count itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findOrphanChainModules,
  runtimeCallerFiles,
  TRANSLATION_CHAIN_MODULES,
} from '../scripts/ci/check-translation-chain-wired.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let root: string;

function write(rel: string, body: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-wired-'));
  for (const moduleRel of TRANSLATION_CHAIN_MODULES) write(moduleRel, 'export const x = 1;\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('findOrphanChainModules', () => {
  it('calls every module orphan when nothing outside scripts/lib mentions it', () => {
    const { orphans, wired } = findOrphanChainModules(root);
    expect(orphans).toEqual([...TRANSLATION_CHAIN_MODULES].sort());
    expect(wired).toEqual({});
  });

  it('does not count another chain module as a caller', () => {
    // The chain importing itself is not wiring.
    write(
      'scripts/lib/translation-state-drainer-v2.mjs',
      "import x from './translation-derived-reducer-v2.mjs';\n",
    );
    const { orphans } = findOrphanChainModules(root);
    expect(orphans).toContain('scripts/lib/translation-derived-reducer-v2.mjs');
  });

  it('does not count a test as a caller', () => {
    write(
      'tests/translation-state-store-v2.test.ts',
      "import x from '../scripts/lib/translation-state-store-v2.mjs';\n",
    );
    const { orphans } = findOrphanChainModules(root);
    expect(orphans).toContain('scripts/lib/translation-state-store-v2.mjs');
  });

  it('counts a script outside scripts/lib as a caller', () => {
    write(
      'scripts/translation-schedule-run-v2.mjs',
      "import { planTranslationScheduleV2 } from './lib/translation-completion-scheduler-v2.mjs';\n",
    );
    const { orphans, wired } = findOrphanChainModules(root);
    expect(orphans).not.toContain('scripts/lib/translation-completion-scheduler-v2.mjs');
    expect(wired['scripts/lib/translation-completion-scheduler-v2.mjs'])
      .toEqual(['scripts/translation-schedule-run-v2.mjs']);
  });

  it('counts a workflow as a caller', () => {
    write(
      '.github/workflows/translation-schedule.yml',
      'jobs:\n  run:\n    steps:\n      - run: node scripts/lib/translation-state-drainer-v2.mjs\n',
    );
    const { orphans } = findOrphanChainModules(root);
    expect(orphans).not.toContain('scripts/lib/translation-state-drainer-v2.mjs');
  });

  it('does not count a mention that cannot execute', () => {
    // A comment, a changelog line, or a workflow `paths:` trigger names the
    // module without running it. `--rebaseline` would then freeze that verdict
    // and retire the module from the orphan set while #7096 is still open.
    write(
      'scripts/notes.mjs',
      "// TODO: wire scripts/lib/translation-journal-v2.mjs one day\n",
    );
    write(
      '.github/workflows/watch.yml',
      'on:\n  push:\n    paths:\n      - scripts/lib/translation-journal-v2.mjs\n',
    );
    const { orphans } = findOrphanChainModules(root);
    expect(orphans).toContain('scripts/lib/translation-journal-v2.mjs');
  });

  it('reports a module that the gate names but that no longer exists', () => {
    fs.rmSync(path.join(root, 'scripts/lib/translation-journal-v2.mjs'));
    const { missing } = findOrphanChainModules(root);
    expect(missing).toEqual(['scripts/lib/translation-journal-v2.mjs']);
  });
});

describe('runtimeCallerFiles', () => {
  it('never includes the gate itself', () => {
    // The gate lists every module name, so counting itself would report the
    // whole chain as wired the moment the gate was added.
    const files = runtimeCallerFiles(REPO_ROOT).map((f) => path.relative(REPO_ROOT, f));
    expect(files).not.toContain(path.join('scripts', 'ci', 'check-translation-chain-wired.mjs'));
  });
});

describe('the committed baseline', () => {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci/translation-chain-wired-baseline.json'), 'utf8'),
  );

  it('still covers every orphan the chain has in this checkout', () => {
    // Ratchet, not equality — the same rule the gate enforces. An exact match
    // would turn SUCCESS into a red: wiring a module up (i.e. doing the work
    // #7096 asks for) would shrink the orphan set and break this test until
    // someone re-ran --rebaseline. What must never happen is a module becoming
    // orphan without the baseline saying so.
    const { orphans } = findOrphanChainModules(REPO_ROOT);
    const known = new Set(baseline.orphans);
    expect(orphans.filter((m: string) => !known.has(m))).toEqual([]);
  });

  it('names only modules the gate actually watches', () => {
    // A baseline entry for a module no longer in the chain would forgive an
    // orphan that nobody is measuring any more.
    expect(baseline.orphans.every((m: string) => TRANSLATION_CHAIN_MODULES.includes(m))).toBe(true);
  });
});
