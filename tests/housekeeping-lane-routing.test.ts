import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

const workflow = YAML.parse(
  readFileSync(new URL('../.github/workflows/housekeeping-jobs-logic.yml', import.meta.url), 'utf8'),
) as {
  jobs: { housekeeping: { steps: Array<{ name?: string; run?: string }> } };
};

const housekeepingScript = workflow.jobs.housekeeping.steps.find(
  (step) => step.name === 'Validate and clean job slices',
)?.run;

const tempRoots: string[] = [];

function fixtureRoot({ prospectiveCount = 1, restCount = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'housekeeping-routing-'));
  tempRoots.push(root);
  const slices = join(root, 'data/jobs/by-crawler');
  const bin = join(root, 'bin');
  mkdirSync(slices, { recursive: true });
  mkdirSync(bin);
  for (let index = 0; index < prospectiveCount; index += 1) {
    writeFileSync(join(slices, `prospective-${index}.json`), '{"url":"https://ohws.prospective.ch/job/1"}\n');
  }
  for (let index = 0; index < restCount; index += 1) {
    writeFileSync(join(slices, `rest-${index}.json`), '{"url":"https://jobs.example.test/job/2"}\n');
  }
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$JOBS_SLICE_FILE" >> "$HOUSEKEEPING_TEST_LOG"\n');
  chmodSync(join(bin, 'node'), 0o755);
  return { root, bin, log: join(root, 'processed.log') };
}

function runLane(
  lane: 'prospective' | 'rest',
  bin: string,
  root: string,
  log: string,
  includeSystemPath = true,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync('/bin/bash', ['-c', housekeepingScript ?? 'exit 99'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOUSEKEEPING_LANE: lane,
      HOUSEKEEPING_TEST_LOG: log,
      PATH: includeSystemPath ? `${bin}:${process.env.PATH ?? ''}` : bin,
      ...extraEnv,
    },
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('housekeeping lane routing', () => {
  it('reads the whole slice so a late matcher error cannot be hidden by an early match', () => {
    expect(housekeepingScript).toContain('grep -Ei -- "$lane_pattern" "$slice" >/dev/null');
    expect(housekeepingScript).not.toContain('grep -Eqi');
  });

  it.each([
    ['prospective', 'data/jobs/by-crawler/prospective-0.json'],
    ['rest', 'data/jobs/by-crawler/rest-0.json'],
  ] as const)('processes only the %s slice', (lane, expectedSlice) => {
    const fixture = fixtureRoot();
    const result = runLane(lane, fixture.bin, fixture.root, fixture.log);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readFileSync(fixture.log, 'utf8').trim()).toBe(expectedSlice);
  });

  it.each(['prospective', 'rest'] as const)(
    'fails the %s lane when the matcher exits non-zero for an operational error',
    (lane) => {
      const fixture = fixtureRoot();
      writeFileSync(join(fixture.bin, 'grep'), '#!/bin/sh\nexit 2\n');
      chmodSync(join(fixture.bin, 'grep'), 0o755);

      const result = runLane(lane, fixture.bin, fixture.root, fixture.log);

      expect(result.status).toBe(2);
      expect(result.stdout).toContain('::error::Failed to classify');
      expect(result.stdout).toContain('grep exit 2');
    },
  );

  it('fails with exit 127 before routing when the matcher binary is missing', () => {
    const fixture = fixtureRoot();
    const result = runLane('rest', fixture.bin, fixture.root, fixture.log, false);

    expect(result.status).toBe(127);
    expect(result.stdout).toContain('::error::grep is required to route housekeeping slices.');
  });

  it.each(['prospective', 'rest'] as const)(
    'keeps %s lane fan-out bounded and reports completed progress',
    (lane) => {
      const fixture = fixtureRoot({ prospectiveCount: 8, restCount: 8 });
      const state = join(fixture.root, 'parallel-state');
      mkdirSync(state);
      writeFileSync(join(state, 'active'), '0');
      writeFileSync(join(state, 'max'), '0');
      writeFileSync(
        join(fixture.bin, 'node'),
        `#!/bin/sh
set -eu
state="$HOUSEKEEPING_TEST_STATE"
lock="$state.lock"
while ! mkdir "$lock" 2>/dev/null; do sleep 0.001; done
active=$(cat "$state/active")
active=$((active + 1))
max=$(cat "$state/max")
if [ "$active" -gt "$max" ]; then printf '%s' "$active" > "$state/max"; fi
printf '%s' "$active" > "$state/active"
rmdir "$lock"
printf '%s\\n' "$JOBS_SLICE_FILE" >> "$HOUSEKEEPING_TEST_LOG"
sleep 0.03
while ! mkdir "$lock" 2>/dev/null; do sleep 0.001; done
active=$(cat "$state/active")
printf '%s' "$((active - 1))" > "$state/active"
rmdir "$lock"
`,
      );
      chmodSync(join(fixture.bin, 'node'), 0o755);

      const result = runLane(lane, fixture.bin, fixture.root, fixture.log, true, {
        HOUSEKEEPING_TEST_STATE: state,
      });

      expect(result.status).toBe(0);
      expect(Number(readFileSync(join(state, 'max'), 'utf8'))).toBe(4);
      expect(result.stdout).toContain('progress: 8/8 slice(s) completed.');
    },
  );

  it.each(['prospective', 'rest'] as const)(
    'fails closed when a %s worker fails',
    (lane) => {
      const fixture = fixtureRoot({ prospectiveCount: 2, restCount: 2 });
      writeFileSync(
        join(fixture.bin, 'node'),
        '#!/bin/sh\ncase "$JOBS_SLICE_FILE" in *-0.json) exit 7;; esac\nprintf "%s\\n" "$JOBS_SLICE_FILE" >> "$HOUSEKEEPING_TEST_LOG"\n',
      );
      chmodSync(join(fixture.bin, 'node'), 0o755);

      const result = runLane(lane, fixture.bin, fixture.root, fixture.log);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('::error::Housekeeping failed');
    },
  );
});
