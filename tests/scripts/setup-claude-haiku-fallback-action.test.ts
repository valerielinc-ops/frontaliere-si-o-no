import { execFileSync } from 'node:child_process';
import fs, { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

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

  it('runs the indirect Codex npm install with no job credentials in its environment', () => {
    const action = fs.readFileSync(actionPath, 'utf8');
    const document = YAML.parse(action) as {
      runs?: { steps?: Array<{ id?: string; run?: string }> };
    };
    const installRun = document.runs?.steps?.find((step) => step.id === 'install_codex_cli')?.run;
    expect(installRun).toBeTruthy();
    expect(installRun).toContain('env -i');
    expect(installRun).toContain('PATH="$PATH"');
    expect(installRun).toContain('HOME="$npm_home"');
    expect(installRun).toContain('CI="true"');
    expect(installRun).toContain('NPM_CONFIG_USERCONFIG="$npmrc"');
    expect(installRun).toContain('npm_config_cache="$npm_cache"');
    expect(installRun).not.toContain('env -u');

    const root = mkdtempSync(path.join(tmpdir(), 'haiku-codex-install-env-'));
    const fakeBin = path.join(root, 'bin');
    const runnerTemp = path.join(root, 'runner-temp');
    const capturePath = path.join(root, 'npm-env.json');
    const outputPath = path.join(root, 'github-output');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(runnerTemp, { recursive: true });
    const fakeNpmPath = path.join(fakeBin, 'npm');
    const codexScript = '#!/bin/sh\nprintf "codex-cli 0.153.4\\n"\n';
    writeFileSync(fakeNpmPath, [
      '#!/usr/bin/env node',
      "import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      `const capturePath = ${JSON.stringify(capturePath)};`,
      `const codexScript = ${JSON.stringify(codexScript)};`,
      'writeFileSync(capturePath, JSON.stringify(process.env));',
      'const args = process.argv.slice(2);',
      "const prefixIndex = args.indexOf('--prefix');",
      'if (prefixIndex < 0 || !args[prefixIndex + 1]) process.exit(2);',
      "const codexPath = join(args[prefixIndex + 1], 'node_modules', '.bin', 'codex');",
      'mkdirSync(dirname(codexPath), { recursive: true });',
      'writeFileSync(codexPath, codexScript, { mode: 0o700 });',
      'chmodSync(codexPath, 0o700);',
    ].join('\n'));
    chmodSync(fakeNpmPath, 0o700);

    const inheritedCredentials = {
      GH_TOKEN: 'github-token-sentinel',
      GITHUB_TOKEN: 'github-actions-token-sentinel',
      GITHUB_PAT: 'github-pat-sentinel',
      NODE_AUTH_TOKEN: 'node-auth-token-sentinel',
      NPM_TOKEN: 'npm-token-sentinel',
      NPM_CONFIG_REGISTRY: 'https://registry.example.invalid/',
      'NPM_CONFIG_//REGISTRY.NPMJS.ORG/:_AUTHTOKEN': 'npmrc-token-sentinel',
      npm_config_userconfig: '/job/.npmrc',
      CODEX_AUTH_JSON: '{"access_token":"codex-sentinel"}',
      CODEX_AUTH_FILE: '/job/auth.json',
      CODEX_API_KEY: 'codex-api-key-sentinel',
      OPENAI_API_KEY: 'openai-key-sentinel',
      ANTHROPIC_API_KEY: 'anthropic-key-sentinel',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth-sentinel',
    };

    try {
      execFileSync('bash', ['-c', installRun as string], {
        cwd: path.dirname(actionPath),
        encoding: 'utf8',
        env: {
          ...process.env,
          ...inheritedCredentials,
          PATH: `${fakeBin}:${process.env.PATH || '/usr/bin:/bin'}`,
          HOME: path.join(root, 'job-home'),
          CI: 'false',
          RUNNER_TEMP: runnerTemp,
          GITHUB_OUTPUT: outputPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const npmEnvironment = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, string>;
      // macOS Node adds this platform encoding hint even after `env -i`.
      const runtimeInjected = new Set(['__CF_USER_TEXT_ENCODING']);
      expect(Object.keys(npmEnvironment).filter((name) => !runtimeInjected.has(name)).sort()).toEqual([
        'CI',
        'HOME',
        'NPM_CONFIG_USERCONFIG',
        'PATH',
        'npm_config_cache',
      ]);
      for (const credentialName of Object.keys(inheritedCredentials)) {
        expect(npmEnvironment).not.toHaveProperty(credentialName);
      }
      expect(npmEnvironment.CI).toBe('true');
      expect(npmEnvironment.PATH).toBe(`${fakeBin}:${process.env.PATH || '/usr/bin:/bin'}`);
      expect(npmEnvironment.HOME).toMatch(/claude-haiku-codex-cli\.[^/]+\/npm-home$/);
      expect(npmEnvironment.NPM_CONFIG_USERCONFIG).toMatch(/claude-haiku-codex-cli\.[^/]+\/npmrc$/);
      expect(npmEnvironment.npm_config_cache).toMatch(/claude-haiku-codex-cli\.[^/]+\/npm-cache$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
