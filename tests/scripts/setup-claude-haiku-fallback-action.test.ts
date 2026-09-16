import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const actionPath = path.resolve(process.cwd(), '.github/actions/setup-claude-haiku-fallback/action.yml');

describe('Codex Luna Max article lane setup action', () => {
  it('installs and exposes only the bounded Codex lane', () => {
    const action = fs.readFileSync(actionPath, 'utf8');
    expect(action).toContain('name: "Setup Codex Luna Max article lane"');
    expect(action).toContain('@openai/codex@0.153.4');
    expect(action).toContain('codex-auth-broker.mjs');
    expect(action).toContain('codex_auth_broker_socket:');
    expect(action).not.toContain('@anthropic-ai/claude-code');
    expect(action).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(action).not.toContain('setup_claude_cli');
    expect(action).toContain('CODEX_AUTH_JSON: ${{ inputs.codex_auth_json }}');
    expect(action).toContain('unset CODEX_AUTH_JSON');
  });

  it('uses a trusted runtime and a credential-free Codex npm install', () => {
    const document = YAML.parse(fs.readFileSync(actionPath, 'utf8')) as {
      runs?: { steps?: Array<{ id?: string; run?: string }> };
    };
    const steps = document.runs?.steps ?? [];
    const resolver = steps.find((step) => step.id === 'trusted_toolchain')?.run ?? '';
    const install = steps.find((step) => step.id === 'install_codex_cli')?.run ?? '';
    expect(resolver).toContain('report_runtime_candidates()');
    expect(resolver).toContain('path_components_trusted');
    expect(resolver).toContain('node_version=');
    expect(resolver).toContain('node_archive_sha256=');
    expect(install).toContain('env -i');
    expect(install).toContain('PATH="$safe_path"');
    expect(install).toContain('NPM_CONFIG_USERCONFIG="$npmrc"');
    expect(install).toContain('npm_config_cache="$npm_cache"');
    expect(install).toContain('@openai/codex@0.153.4');
    expect(install).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('keeps credentials inside the broker bootstrap boundary', () => {
    const action = fs.readFileSync(actionPath, 'utf8');
    expect(action).toContain('mkfifo "$auth_fifo"');
    expect(action).toContain('printf \'%s\' "$CODEX_AUTH_JSON" > "$auth_fifo"');
    expect(action).toContain('chmod 700 "$auth_dir"');
    expect(action).toContain('chmod 600 "$broker_socket"');
    expect(action).toContain('printf \'socket=%s\\n\' "$broker_socket" >> "$GITHUB_OUTPUT"');
    expect(action).toContain('--max-requests 512');
    expect(action).toContain('codex-luna-max-codex-cli.XXXXXX');
    expect(action).not.toContain('CODEX_AUTH_BROKER_SOCKET=');
    expect(action).not.toContain('CODEX_AUTH_FILE=');
  });
});
