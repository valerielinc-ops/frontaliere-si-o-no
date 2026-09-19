import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW = readFileSync(new URL('../.github/workflows/recycle-stale-prs.yml', import.meta.url), 'utf8');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function recycleScript(): string {
  const step = WORKFLOW.indexOf('- name: Recycle deeply-stale stale-review PRs');
  const start = WORKFLOW.indexOf('\n        run: |', step);
  const end = WORKFLOW.indexOf('\n      - name: Flag parked draft PRs', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return WORKFLOW.slice(start + '\n        run: |\n'.length, end)
    .split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n');
}

const FAKE_GH = `#!/bin/sh
set -eu
log="\${FAKE_LOG:?}"
state="\${FAKE_STATE:?}"
printf '%s\\n' "$*" >>"$log"
printf '%s|%s\\n' "\${GH_TOKEN:-}" "$*" >>"$log.tok"

get_state() {
  awk -F= -v key="$1" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$state"
}

set_state() {
  key="$1"
  value="$2"
  tmp="$state.tmp"
  awk -F= -v key="$key" -v value="$value" '
    $1 == key { print key "=" value; found=1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$state" >"$tmp"
  mv "$tmp" "$state"
}

command="\${1:-}"
shift || true
args="$*"

case "$command" in
  api)
    if printf '%s' "$args" | grep -q -- '--paginate'; then
      printf '%s\\n' '{"number":17,"title":"fix stale (#77)","body":"","createdAt":"2020-01-01T00:00:00Z","headRefName":"fix/issue-77","labels":[{"name":"stale-review"},{"name":"agent:autofix"}]}'
      exit 0
    fi
    if printf '%s' "$args" | grep -q -- '-X DELETE'; then
      set_state REF_PRESENT false
      exit 0
    fi
    if printf '%s' "$args" | grep -q -- 'issues/17/comments'; then
      if [ "\${FAKE_COMMENT:-ok}" = fail ]; then exit 1; fi
      printf '%s 2026-01-01T00:00:00Z\\n' "\${FAKE_ACTOR:-fixer-bot}"
      exit 0
    fi
    if printf '%s' "$args" | grep -q -- 'repos/owner/repo/issues/17 '; then
      if [ "$(get_state PR_STATE)" = CLOSED ]; then
        printf 'closed %s %s\\n' "\${FAKE_CLOSED_AT:-2026-01-01T00:00:05Z}" "\${FAKE_CLOSED_BY:-fixer-bot}"
      else
        printf 'open - -\\n'
      fi
      exit 0
    fi
    if printf '%s' "$args" | grep -q -- '--include'; then
      mode="\${FAKE_REF_MODE:-sha}"
      if [ "$mode" = 404 ] || [ "$(get_state REF_PRESENT)" != true ]; then
        printf 'HTTP/2 404 Not Found\\n\\n{"message":"Not Found"}\\n'
        exit 1
      fi
      case "$mode" in
        403) printf 'HTTP/2 403 Forbidden\\n\\n{"message":"Forbidden"}\\n'; exit 1 ;;
        500) printf 'HTTP/2 500 Server Error\\n\\n{"message":"Server error"}\\n'; exit 1 ;;
        timeout) exit 1 ;;
        malformed) printf 'HTTP/2 200 OK\\n\\n{}\\n'; exit 0 ;;
        mismatch) printf 'HTTP/2 200 OK\\n\\n{"object":{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}\\n'; exit 0 ;;
        *) printf 'HTTP/2 200 OK\\n\\n{"object":{"sha":"%s"}}\\n' "\${FAKE_HEAD_SHA:-${SHA}}"; exit 0 ;;
      esac
    fi
    ;;
  pr)
    sub="\${1:-}"
    shift || true
    args="$*"
    if [ "$sub" = close ]; then
      if [ "\${FAKE_CLOSE:-ok}" = fail ]; then exit 1; fi
      if printf '%s' "$args" | grep -q -- '--delete-branch'; then
        set_state PREMATURE_DELETE true
        set_state REF_PRESENT false
      fi
      if [ "\${FAKE_CLOSE:-ok}" != open ]; then set_state PR_STATE CLOSED; fi
      exit 0
    fi
    if [ "$sub" = view ]; then
      if printf '%s' "$args" | grep -q -- '--json state,headRefOid'; then
        printf '%s %s\\n' "$(get_state PR_STATE)" "\${FAKE_PRE_SHA:-${SHA}}"
      else
        if [ "\${FAKE_HEAD_METADATA:-ok}" = partial ]; then
          printf '{"commits":[{"committedDate":"2020-01-01T00:00:00Z"}],"headRepository":{"nameWithOwner":"%s"}}\\n' "\${FAKE_HEAD_REPO:-owner/repo}"
        else
          printf '{"commits":[{"committedDate":"2020-01-01T00:00:00Z"}],"headRepository":{"nameWithOwner":"%s"},"headRepositoryOwner":{"login":"owner"},"headRefName":"fix/issue-77","headRefOid":"%s"}\\n' "\${FAKE_HEAD_REPO:-owner/repo}" "${SHA}"
        fi
      fi
      exit 0
    fi
    ;;
  issue)
    sub="\${1:-}"
    shift || true
    args="$*"
    if [ "$sub" = view ]; then
      if printf '%s' "$args" | grep -q -- '--json labels'; then
        if [ "\${FAKE_LABEL_QUERY:-ok}" = malformed ]; then printf '{}\\n'; elif [ "\${FAKE_LABEL_QUERY:-ok}" = malformed-record ]; then printf '{\"labels\":[{}]}\\n'; elif [ "$(get_state LABEL_PRESENT)" = true ]; then printf '{\"labels\":[{\"name\":\"agent:fix\"}]}\\n'; else printf '{\"labels\":[]}\\n'; fi
      else
        printf 'OPEN\\n'
      fi
      exit 0
    fi
    if [ "$sub" = edit ]; then
      if printf '%s' "$args" | grep -q -- '--remove-label'; then
        if [ "\${FAKE_REMOVE:-ok}" = fail ]; then exit 1; fi
        if [ "\${FAKE_REMOVE:-ok}" != stuck ]; then set_state LABEL_PRESENT false; fi
        exit 0
      fi
      if printf '%s' "$args" | grep -q -- '--add-label'; then
        if [ "\${FAKE_ADD:-ok}" = fail ]; then exit 1; fi
        if [ "\${FAKE_ADD:-ok}" != silent ]; then set_state LABEL_PRESENT true; fi
        exit 0
      fi
      exit 0
    fi
    ;;
esac
exit 0
`;

function runScenario(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'site-recycle-stale-actions-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const fakeGh = join(bin, 'gh');
  const fakeSleep = join(bin, 'sleep');
  const fakeDate = join(bin, 'date');
  const log = join(dir, 'gh.log');
  const state = join(dir, 'state');
  writeFileSync(fakeGh, FAKE_GH);
  writeFileSync(fakeSleep, '#!/bin/sh\nexit 0\n');
  writeFileSync(fakeDate, '#!/bin/sh\ncase "$*" in\n  "-u +%s") printf "2000000000\\n" ;;\n  "-u -d "*" +%s") printf "1577836800\\n" ;;\n  *) exit 1 ;;\nesac\n');
  writeFileSync(log, '');
  writeFileSync(state, 'LABEL_PRESENT=true\nREF_PRESENT=true\nPREMATURE_DELETE=false\nPR_STATE=OPEN\n');
  chmodSync(fakeGh, 0o755);
  chmodSync(fakeSleep, 0o755);
  chmodSync(fakeDate, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH || ''}`,
    BASH_ENV: '/dev/null',
    GH_TOKEN: 'base-token',
    PAT: 'runtime-token',
    REPO: 'owner/repo',
    DRY_RUN: 'false',
    MAX_AGE_HOURS: '24',
    MAX_RECYCLES_PER_RUN: '5',
    FAKE_LOG: log,
    FAKE_STATE: state,
    FAKE_BIN: bin,
    FAKE_HEAD_SHA: SHA,
    ...overrides,
  };
  const script = ['set -uo pipefail', 'PATH="$FAKE_BIN:$PATH"', recycleScript()].join('\n');
  let output = '';
  try {
    output = execFileSync('bash', ['-c', script], { encoding: 'utf8', env });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    output = `${failure.stdout || ''}${failure.stderr || ''}`;
  }
  const events = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  let tokens: string[] = [];
  try {
    tokens = readFileSync(`${log}.tok`, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    tokens = [];
  }
  const stateText = readFileSync(state, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { output, events, tokens, stateText };
}

function eventIndex(events: string[], pattern: RegExp, from = 0): number {
  return events.findIndex((event, index) => index >= from && pattern.test(event));
}

describe('recycle-stale-prs — R2 action contract', () => {
  it('esegue close, verifica, ref guard e remove→verify→add→verify in ordine', () => {
    const result = runScenario();
    expect(result.output).toContain('issue #77 ri-accodata');
    const preClose = eventIndex(result.events, /^pr view 17 .*--json state,headRefOid/);
    const announce = eventIndex(result.events, /^api -X POST repos\/owner\/repo\/issues\/17\/comments/);
    const close = eventIndex(result.events, /^pr close 17/);
    const state = eventIndex(result.events, /^api repos\/owner\/repo\/issues\/17 /);
    const probe = eventIndex(result.events, /^api .*--include/);
    const del = eventIndex(result.events, /^api -X DELETE /);
    const remove = eventIndex(result.events, /^issue edit 77 .*--remove-label agent:fix/);
    const removeVerify = eventIndex(result.events, /^issue view 77 .*--json labels/);
    const add = eventIndex(result.events, /^issue edit 77 .*--add-label agent:fix/);
    const addVerify = eventIndex(result.events, /^issue view 77 .*--json labels/, removeVerify + 1);
    expect(preClose).toBeGreaterThanOrEqual(0);
    expect(announce).toBeGreaterThan(preClose);
    expect(close).toBeGreaterThan(announce);
    expect(state).toBeGreaterThan(close);
    expect(probe).toBeGreaterThan(state);
    expect(del).toBeGreaterThan(probe);
    expect(remove).toBeGreaterThan(del);
    expect(removeVerify).toBeGreaterThan(remove);
    expect(add).toBeGreaterThan(removeVerify);
    expect(addVerify).toBeGreaterThan(add);
    expect(result.stateText).toMatch(/PREMATURE_DELETE=false/);
    expect(result.events.find((event) => event.startsWith('pr close 17') || '')).not.toMatch(/--delete-branch/);
  });

  it.each([
    ['close failure', { FAKE_CLOSE: 'fail' }],
    ['close state unverified', { FAKE_CLOSE: 'open' }],
  ])('%s non raggiunge ref o label', (_name, overrides) => {
    const result = runScenario(overrides);
    const log = result.events.join('\n');
    expect(log).not.toMatch(/--include/);
    expect(log).not.toMatch(/--remove-label agent:fix/);
    expect(log).not.toMatch(/--add-label agent:fix/);
  });

  it.each(['403', '500', 'timeout', 'malformed'])('probe %s è fail-closed', (mode) => {
    const result = runScenario({ FAKE_REF_MODE: mode });
    const log = result.events.join('\n');
    expect(log).not.toMatch(/--remove-label agent:fix/);
    expect(log).not.toMatch(/--add-label agent:fix/);
  });

  it('HEAD cambiata dopo close non autorizza alcun DELETE', () => {
    const result = runScenario({ FAKE_REF_MODE: 'mismatch' });
    expect(result.events.join('\n')).not.toMatch(/-X DELETE/);
    expect(result.stateText).toMatch(/REF_PRESENT=true/);
    expect(result.stateText).toMatch(/PREMATURE_DELETE=false/);
  });

  it('probe 404 confermato abilita il re-queue senza DELETE', () => {
    const result = runScenario({ FAKE_REF_MODE: '404' });
    expect(result.events.join('\n')).toMatch(/--remove-label agent:fix/);
    expect(result.events.join('\n')).not.toMatch(/-X DELETE/);
  });

  it('fork o target head sconosciuto non autorizza close/DELETE nel base repo', () => {
    const result = runScenario({ FAKE_HEAD_REPO: 'other/fork' });
    const log = result.events.join('\n');
    expect(log).not.toMatch(/^pr close 17/m);
    expect(log).not.toMatch(/-X DELETE/);
    expect(result.output).toContain('head repository non verificabile');
  });

  it('metadata HEAD parziale non autorizza close, DELETE o re-queue', () => {
    const result = runScenario({ FAKE_HEAD_METADATA: 'partial' });
    const log = result.events.join('\n');
    expect(log).not.toMatch(/^pr close 17/m);
    expect(log).not.toMatch(/-X DELETE/);
    expect(log).not.toMatch(/--remove-label agent:fix/);
    expect(log).not.toMatch(/--add-label agent:fix/);
    expect(result.output).toContain('metadata head ref/SHA non verificabile');
  });

  it('max_recycles enorme o oltre il limite operativo è fail-closed', () => {
    for (const value of ['999999999999999999999999999999999999', '101', '21']) {
      const result = runScenario({ MAX_RECYCLES_PER_RUN: value });
      const log = result.events.join('\n');
      expect(log).not.toMatch(/^pr close 17/m);
      expect(result.output).toContain('MAX_RECYCLES_PER_RUN');
    }
  });

  it.each([
    { FAKE_REMOVE: 'fail' },
    { FAKE_REMOVE: 'stuck' },
    { FAKE_LABEL_QUERY: 'malformed' },
    { FAKE_LABEL_QUERY: 'malformed-record' },
  ])('remove fallito o non verificato non puo\' fingere un retrigger add', (overrides) => {
    const result = runScenario({ FAKE_REF_MODE: '404', ...overrides });
    expect(result.events.join('\n')).not.toMatch(/--add-label agent:fix/);
  });

  it('PAT assente blocca la prima azione distruttiva', () => {
    const result = runScenario({ PAT: '' });
    const log = result.events.join('\n');
    expect(log).not.toMatch(/^pr close 17/m);
    expect(log).not.toMatch(/--remove-label agent:fix/);
  });

  it('tutte le mutazioni usano la stessa identita\' PAT/App, mai GITHUB_TOKEN', () => {
    const result = runScenario();
    expect(result.output).toContain('issue #77 ri-accodata');
    const mutations = result.tokens.filter((line) =>
      /\|(pr close |api -X |issue edit |issue comment )/.test(line));
    expect(mutations.length).toBeGreaterThanOrEqual(5);
    for (const line of mutations) expect(line.startsWith('runtime-token|')).toBe(true);
  });

  it('token PAT/App non operativo: il preflight fallisce prima di close e DELETE', () => {
    const result = runScenario({ FAKE_COMMENT: 'fail' });
    const log = result.events.join('\n');
    expect(log).not.toMatch(/^pr close 17/m);
    expect(log).not.toMatch(/-X DELETE/);
    expect(log).not.toMatch(/--remove-label agent:fix/);
    expect(result.output).toContain('preflight del token');
    expect(result.stateText).toMatch(/REF_PRESENT=true/);
  });

  it('head o stato cambiati prima della close: nessuna mutazione', () => {
    const result = runScenario({ FAKE_PRE_SHA: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    const log = result.events.join('\n');
    expect(log).not.toMatch(/issues\/17\/comments/);
    expect(log).not.toMatch(/^pr close 17/m);
    expect(result.output).toContain('cambiata prima della close');
  });

  it.each([
    ['chiusa da un altro actor', { FAKE_CLOSED_BY: 'someone-else' }],
    ['chiusa prima del preflight', { FAKE_CLOSED_AT: '2025-12-31T23:59:59Z' }],
    ['closed_by illeggibile', { FAKE_CLOSED_BY: '-' }],
  ])('close non attribuibile (%s): niente DELETE ne\' re-queue, commento di recovery', (_name, overrides) => {
    const result = runScenario(overrides);
    const log = result.events.join('\n');
    expect(log).not.toMatch(/--include/);
    expect(log).not.toMatch(/-X DELETE/);
    expect(log).not.toMatch(/--remove-label agent:fix/);
    expect(log).toMatch(/^issue comment 77 /m);
    expect(result.output).toContain('close non attribuibile');
    expect(result.stateText).toMatch(/REF_PRESENT=true/);
  });

  it('deadline: nessuna nuova close se il tempo restante e\' sotto il budget di un riciclo', () => {
    const result = runScenario({ RECYCLE_STEP_BUDGET_SECONDS: '30', RECYCLE_PER_ITEM_BUDGET_SECONDS: '60' });
    const log = result.events.join('\n');
    expect(log).not.toMatch(/issues\/17\/comments/);
    expect(log).not.toMatch(/^pr close 17/m);
    expect(result.output).toContain('Deadline');
  });

  it('il job ha un tetto coerente con la deadline interna e il cap 20', () => {
    expect(WORKFLOW).toMatch(/timeout-minutes: 15/);
    expect(WORKFLOW).toMatch(/RECYCLE_STEP_BUDGET_SECONDS: '420'/);
    expect(WORKFLOW).toMatch(/timeout-minutes: 9\n        run: \|/);
  });

  it('remove fallito dopo close+DELETE lascia un commento di recovery', () => {
    const result = runScenario({ FAKE_REMOVE: 'fail' });
    expect(result.events.join('\n')).toMatch(/^issue comment 77 /m);
  });
});
