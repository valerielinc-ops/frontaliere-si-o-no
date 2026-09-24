import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const action = (name: string) => YAML.parse(readFileSync(new URL(`../../.github/actions/${name}/action.yml`, import.meta.url), 'utf8'));

describe('Codex sandbox prerequisites on Ubuntu', () => {
  it('loads the distro AppArmor profile and probes network namespaces without disabling isolation', () => {
    const run = action('setup-codex-sandbox').runs.steps[0].run;
    expect(run).toContain('apt-get install -y -qq bubblewrap apparmor-profiles apparmor-utils');
    expect(run).toContain('/usr/sbin/apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict');
    expect(run).toContain('/usr/bin/bwrap --unshare-user --unshare-net');
    expect(run).not.toContain('sysctl');
    expect(run).not.toContain('danger-full-access');
  });

  // Smoke-test-ai-models run 35995800618: l'hook apt di needrestart riavviava
  // php8.3-fpm dopo l'install di bubblewrap, e il restart andava in timeout a
  // 90 s su ogni run Codex. Ogni apt-get deve girare con l'hook sospeso.
  it('suspends needrestart for every apt-get call, through sudo', () => {
    const run: string = action('setup-codex-sandbox').runs.steps[0].run;
    const aptCalls = run.split('\n').filter((line) => line.includes('/usr/bin/apt-get'));
    expect(aptCalls.length).toBeGreaterThanOrEqual(2);
    for (const line of aptCalls) {
      expect(line.trim()).toMatch(/^\/usr\/bin\/sudo "\$\{apt_env\[@\]\}" \/usr\/bin\/apt-get /);
    }
    const aptEnv = run.split('\n').find((line) => line.trim().startsWith('apt_env=('))?.trim() ?? '';
    expect(aptEnv).toMatch(/^apt_env=\(\/usr\/bin\/env /);
    // L'array vero, espanso da bash: le variabili arrivano davvero al comando.
    const probe = spawnSync('/bin/bash', ['-c', `${aptEnv}\n"\${apt_env[@]}" /usr/bin/printenv NEEDRESTART_SUSPEND NEEDRESTART_MODE DEBIAN_FRONTEND`], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim().split('\n')).toEqual(['1', 'l', 'noninteractive']);
  });

  it('prepares the sandbox before loading direct fallback credentials', () => {
    const steps = action('claude-codex-fallback').runs.steps;
    const setup = steps.findIndex((s: { uses?: string }) => s.uses === './.github/actions/setup-codex-sandbox');
    const auth = steps.findIndex((s: { id?: string }) => s.id === 'codex_auth');
    expect(setup).toBeGreaterThan(-1);
    expect(setup).toBeLessThan(auth);
    expect(steps[setup]['continue-on-error']).not.toBe(true);
  });

  it('preserves the normal indirect cascade if sandbox setup fails', () => {
    const steps = action('setup-claude-haiku-fallback').runs.steps;
    expect(steps.find((s: { id?: string }) => s.id === 'setup_codex_sandbox')['continue-on-error']).toBe(true);
    expect(steps.find((s: { id?: string }) => s.id === 'install_codex_cli').if).toContain("steps.setup_codex_sandbox.outcome == 'success'");
  });
});
