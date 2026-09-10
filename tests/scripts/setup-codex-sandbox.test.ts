import { readFileSync } from 'node:fs';
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
