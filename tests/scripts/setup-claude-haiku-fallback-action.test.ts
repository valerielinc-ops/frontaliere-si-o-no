import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const actionPath = path.resolve(process.cwd(), '.github/actions/setup-claude-haiku-fallback/action.yml');

describe('Claude Haiku fallback setup action', () => {
  it('keeps Codex installation best-effort without disabling Claude/cascade', () => {
    const action = fs.readFileSync(actionPath, 'utf8');
    expect(action).toContain('npm install --prefix "$codex_prefix" --no-save --no-package-lock');
    expect(action).toContain('@openai/codex@0.153.4');
    expect(action).not.toContain('npm install -g --no-fund --no-audit @openai/codex@0.153.4');
    expect(action).toContain('::warning::Codex CLI install failed; Claude and the normal fallback cascade remain available');
    expect(action).toContain('echo "ENABLE_HAIKU_ARTICLE_FALLBACK=1" >> "$GITHUB_ENV"');
  });

  it('keeps auth inside a one-shot broker and exposes its socket only as an action output', () => {
    const action = fs.readFileSync(actionPath, 'utf8');
    expect(action).toContain('codex_auth_json:');
    expect(action).toContain('codex_auth_broker_socket:');
    expect(action).toContain('CODEX_AUTH_JSON: ${{ inputs.codex_auth_json }}');
    expect(action).toContain('codex-auth-broker.mjs');
    expect(action).toContain('mkfifo "$auth_fifo"');
    expect(action).toContain('printf \'%s\' "$CODEX_AUTH_JSON" > "$auth_fifo"');
    expect(action).toContain('chmod 700 "$auth_dir"');
    expect(action).toContain('chmod 600 "$broker_socket"');
    expect(action).toContain("printf 'socket=%s\\n' \"$broker_socket\" >> \"$GITHUB_OUTPUT\"");
    expect(action).toContain('--codex-bin "$CODEX_CLI_BIN"');
    expect(action).toContain('--codex-realpath "$CODEX_CLI_REALPATH"');
    expect(action).toContain('--codex-sha256 "$CODEX_CLI_SHA256"');
    expect(action).toContain('--codex-prefix "$CODEX_CLI_PREFIX"');
    expect(action).toContain('claude-haiku-codex-cli.XXXXXX');
    expect(action).toContain('env -i PATH="$PATH"');
    expect(action).toContain('--ttl-ms 1800000');
    expect(action).not.toContain('--ttl-ms 25200000');
    expect(action).not.toContain('CODEX_AUTH_BROKER_SOCKET=');
    expect(action).not.toContain('CODEX_AUTH_FILE=');
    expect(action).not.toContain('CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}');
  });
});
