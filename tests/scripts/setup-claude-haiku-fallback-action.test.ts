import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { chmodSync, copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const actionPath = path.resolve(process.cwd(), '.github/actions/setup-claude-haiku-fallback/action.yml');
const cryptoHash = (filePath: string) => {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

describe('Claude Haiku fallback setup action', () => {
  it('keeps Codex installation best-effort without disabling Claude/cascade', () => {
    const action = fs.readFileSync(actionPath, 'utf8');
    expect(action).toContain('"$trusted_node" "$trusted_npm" install --prefix "$codex_prefix" --no-save --no-package-lock');
    expect(action).toContain('@openai/codex@0.153.4');
    expect(action).not.toContain('npm install -g --no-fund --no-audit @openai/codex@0.153.4');
    expect(action).toContain('@anthropic-ai/claude-code@2.1.267');
    expect(action).not.toContain('npm install -g @anthropic-ai/claude-code');
    expect(action).toContain('"$trusted_node" "$trusted_npm" install --global');
    expect(action).toContain('Unexpected Claude Code package version');
    expect(action).toContain('Unexpected Claude Code CLI version');
    expect(action).toContain('claude_cli_semver="${BASH_REMATCH[1]}"');
    expect(action).toContain("if [ \"$claude_cli_semver\" != '2.1.267' ]; then");
    expect(action).toContain('::warning::Codex CLI install failed; Claude and the normal fallback cascade remain available');
    expect(action).toContain('echo "ENABLE_HAIKU_ARTICLE_FALLBACK=1" >> "$GITHUB_ENV"');
  });

  it('uses a checksum-pinned private Node runtime when the runner toolcache is rejected', () => {
    const action = fs.readFileSync(actionPath, 'utf8');
    const resolverRun = (YAML.parse(action) as {
      runs?: { steps?: Array<{ id?: string; run?: string }> };
    }).runs?.steps?.find((step) => step.id === 'trusted_toolchain')?.run;
    expect(resolverRun).toBeTruthy();
    const fallbackStart = (resolverRun as string).indexOf("node_version='v24.21.0'");
    expect(fallbackStart).toBeGreaterThan(0);
    expect(resolverRun).toContain('report_runtime_candidates()');
    expect(resolverRun).toContain('trusted-runtime candidate=%s mode=%s owner=%s');
    expect(resolverRun).toContain('path_components_trusted "$host_tool"');
    expect(resolverRun).toContain(
      'node_archive="node-' + String.fromCharCode(36, 123) + 'node_version}-linux-x64.tar.xz"',
    );
    expect(resolverRun).toContain(
      "node_archive_sha256='fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6'",
    );
    expect(resolverRun).toContain('node_runtime_root="$(/usr/bin/mktemp -d "$runner_temp/claude-haiku-node.XXXXXX")"');
    expect(resolverRun).toContain('/usr/bin/curl --fail --silent --show-error --location --proto \'=https\' --tlsv1.2');
    expect(resolverRun).toContain('if [ "$archive_sha256" != "$node_archive_sha256" ]');
    expect(resolverRun).toContain('/usr/bin/chmod -R go-rwx "$node_root"');
    expect(resolverRun).toContain('"$node_root"/*:"$node_root"/*');
    expect((resolverRun as string).indexOf('if [ -z "$node_realpath" ] || [ -z "$npm_realpath" ]; then', fallbackStart))
      .toBeGreaterThan(fallbackStart);
  });

  it('runs the indirect Codex npm install with no job credentials in its environment', () => {
    const action = fs.readFileSync(actionPath, 'utf8');
    const document = YAML.parse(action) as {
      runs?: { steps?: Array<{ id?: string; run?: string }> };
    };
    const installRun = document.runs?.steps?.find((step) => step.id === 'install_codex_cli')?.run;
    expect(installRun).toBeTruthy();
    expect(installRun).toContain('env -i');
    expect(installRun).toContain('PATH="$safe_path"');
    expect(installRun).toContain('HOME="$npm_home"');
    expect(installRun).toContain('CI="true"');
    expect(installRun).toContain('NPM_CONFIG_USERCONFIG="$npmrc"');
    expect(installRun).toContain('NPM_CONFIG_GLOBALCONFIG="$global_npmrc"');
    expect(installRun).toContain('npm_config_cache="$npm_cache"');
    expect(installRun).toContain('"$trusted_node" "$trusted_npm" install');
    expect(action).toContain('TRUSTED_NPM: ${{ steps.trusted_toolchain.outputs.npm_realpath }}');
    expect(installRun).not.toContain('env -u');

    const root = mkdtempSync(path.join(tmpdir(), 'haiku-codex-install-env-'));
    const fakeBin = path.join(root, 'bin');
    const runnerTemp = path.join(root, 'runner-temp');
    const capturePath = path.join(root, 'npm-env.json');
    const outputPath = path.join(root, 'github-output');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(runnerTemp, { recursive: true });
    const fakeNpmPath = path.join(fakeBin, 'npm-cli.js');
    const codexScript = '#!/bin/sh\nprintf "codex-cli 0.153.4\\n"\n';
    writeFileSync(fakeNpmPath, [
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
          GITHUB_WORKSPACE: path.resolve(path.dirname(actionPath), '../../..'),
          GITHUB_ACTION_PATH: path.dirname(actionPath),
          RUNNER_TEMP: runnerTemp,
          GITHUB_OUTPUT: outputPath,
          TRUSTED_NODE: fs.realpathSync(process.execPath),
          TRUSTED_NODE_SHA256: cryptoHash(fs.realpathSync(process.execPath)),
          TRUSTED_NPM: fakeNpmPath,
          TRUSTED_NPM_SHA256: cryptoHash(fakeNpmPath),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const npmEnvironment = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, string>;
      // macOS Node adds this platform encoding hint even after `env -i`.
      const runtimeInjected = new Set(['__CF_USER_TEXT_ENCODING']);
      expect(Object.keys(npmEnvironment).filter((name) => !runtimeInjected.has(name)).sort()).toEqual([
        'CI',
        'HOME',
        'NPM_CONFIG_GLOBALCONFIG',
        'NPM_CONFIG_USERCONFIG',
        'PATH',
        'npm_config_cache',
      ]);
      for (const credentialName of Object.keys(inheritedCredentials)) {
        expect(npmEnvironment).not.toHaveProperty(credentialName);
      }
      expect(npmEnvironment.CI).toBe('true');
      expect(npmEnvironment.PATH).toBe(`${fakeBin}:${path.dirname(fs.realpathSync(process.execPath))}:/usr/bin:/bin`);
      expect(npmEnvironment.HOME).toMatch(/claude-haiku-codex-cli\.[^/]+\/npm-home$/);
      expect(npmEnvironment.NPM_CONFIG_USERCONFIG).toMatch(/claude-haiku-codex-cli\.[^/]+\/npmrc$/);
      expect(npmEnvironment.npm_config_cache).toMatch(/claude-haiku-codex-cli\.[^/]+\/npm-cache$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts the pinned Claude CLI semver with the Claude Code output suffix', () => {
    const action = fs.readFileSync(actionPath, 'utf8');
    const setupRun = (YAML.parse(action) as {
      runs?: { steps?: Array<{ id?: string; run?: string }> };
    }).runs?.steps?.find((step) => step.id === 'setup_claude_cli')?.run;
    expect(setupRun).toBeTruthy();
    expect(setupRun).toContain('@anthropic-ai/claude-code@2.1.267');
    expect(setupRun).toContain('NPM_CONFIG_GLOBALCONFIG="$global_npmrc"');
    expect(setupRun).toContain('"$trusted_node" "$trusted_npm" install --global');

    const root = mkdtempSync(path.join(tmpdir(), 'haiku-claude-install-env-'));
    const trustedBin = path.join(root, 'trusted-bin');
    const evilBin = path.join(root, 'evil-bin');
    const runnerTemp = path.join(root, 'runner-temp');
    const globalPrefix = path.join(root, 'global-prefix');
    const globalRoot = path.join(globalPrefix, 'lib', 'node_modules');
    const capturePath = path.join(root, 'npm-env.json');
    const evilMarker = path.join(root, 'evil-npm-used');
    const githubEnv = path.join(root, 'github-env');
    const githubPath = path.join(root, 'github-path');
    fs.mkdirSync(trustedBin, { recursive: true });
    fs.mkdirSync(evilBin, { recursive: true });
    fs.mkdirSync(runnerTemp, { recursive: true });
    fs.mkdirSync(globalRoot, { recursive: true });
    const trustedNode = fs.realpathSync(process.execPath);
    const fakeNpmPath = path.join(trustedBin, 'npm-cli.js');
    const fakeNpmSource = [
      "import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `const globalPrefix = ${JSON.stringify(globalPrefix)};`,
      `const globalRoot = ${JSON.stringify(globalRoot)};`,
      `const capturePath = ${JSON.stringify(capturePath)};`,
      `const expectedPackage = ${JSON.stringify('@anthropic-ai/claude-code@2.1.267')};`,
      'const args = process.argv.slice(2);',
      "if (args[0] === 'prefix') { process.stdout.write(`${globalPrefix}\\n`); process.exit(0); }",
      "if (args[0] === 'root') { process.stdout.write(`${globalRoot}\\n`); process.exit(0); }",
      "if (args[0] !== 'install' || !args.includes(expectedPackage)) process.exit(2);",
      'writeFileSync(capturePath, JSON.stringify({ env: process.env, args }));',
      "const packageRoot = join(globalRoot, '@anthropic-ai', 'claude-code');",
      'mkdirSync(packageRoot, { recursive: true });',
      "writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version: '2.1.267' }));",
      "const claudePath = join(globalPrefix, 'bin', 'claude');",
      "mkdirSync(join(globalPrefix, 'bin'), { recursive: true });",
      "writeFileSync(claudePath, '#!/bin/sh\\nprintf \\\"2.1.267 (Claude Code)\\\\n\\\"; printf \\\"diagnostic: runtime ready\\\\n\\\"\\n');",
      'chmodSync(claudePath, 0o700);',
    ].join('\n');
    writeFileSync(fakeNpmPath, fakeNpmSource);
    chmodSync(fakeNpmPath, 0o700);
    const evilNpmPath = path.join(evilBin, 'npm');
    writeFileSync(evilNpmPath, `#!/bin/sh\nprintf used > ${JSON.stringify(evilMarker)}\nexit 97\n`);
    chmodSync(evilNpmPath, 0o700);
    const fixturePrefix = fs.realpathSync(globalPrefix).replaceAll("'", "'\\''");
    const setupScript = (setupRun as string)
      .split('\n')
      .map((line) => line.startsWith('        ') ? line.slice(8) : line)
      .join('\n')
      .replace(
        'case "$global_prefix" in\n  "$trusted_node_root"|"$trusted_node_root"/*|/usr|/usr/*|/usr/local|/usr/local/*|/bin|/bin/*|/opt/hostedtoolcache|/opt/hostedtoolcache/*|/opt/runner|/opt/runner/*|/opt/homebrew|/opt/homebrew/*) ;;',
        `case "$global_prefix" in\n  '${fixturePrefix}'|"$trusted_node_root"|"$trusted_node_root"/*|/usr|/usr/*|/usr/local|/usr/local/*|/bin|/bin/*|/opt/hostedtoolcache|/opt/hostedtoolcache/*|/opt/runner|/opt/runner/*|/opt/homebrew|/opt/homebrew/*) ;;`,
      );
    expect(setupScript).toContain(`'${fixturePrefix}'|"$trusted_node_root"`);
    const inheritedCredentials = {
      GH_TOKEN: 'github-token-sentinel',
      GITHUB_TOKEN: 'github-actions-token-sentinel',
      GITHUB_PAT: 'github-pat-sentinel',
      NODE_AUTH_TOKEN: 'node-auth-token-sentinel',
      NPM_TOKEN: 'npm-token-sentinel',
      GITHUB_ENV: 'github-env-sentinel',
      CODEX_AUTH_JSON: '{"access_token":"codex-sentinel"}',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth-sentinel',
    };
    try {
      execFileSync('/bin/bash', ['-c', setupScript], {
        cwd: path.dirname(actionPath),
        encoding: 'utf8',
        env: {
          ...process.env,
          ...inheritedCredentials,
          PATH: `${evilBin}:${trustedBin}:${path.dirname(trustedNode)}:/usr/bin:/bin`,
          RUNNER_TEMP: runnerTemp,
          GITHUB_ENV: githubEnv,
          GITHUB_PATH: githubPath,
          TRUSTED_NODE: trustedNode,
          TRUSTED_NODE_SHA256: cryptoHash(trustedNode),
          TRUSTED_NPM: fakeNpmPath,
          TRUSTED_NPM_SHA256: cryptoHash(fakeNpmPath),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as {
        env: Record<string, string>;
        args: string[];
      };
      expect(captured.args).toContain('@anthropic-ai/claude-code@2.1.267');
      for (const credentialName of Object.keys(inheritedCredentials)) {
        expect(captured.env).not.toHaveProperty(credentialName);
      }
      expect(captured.env).toMatchObject({
        CI: 'true',
        NPM_CONFIG_USERCONFIG: '/dev/null',
      });
      expect(captured.env.NPM_CONFIG_GLOBALCONFIG).toMatch(/global-npmrc$/);
      expect(fs.existsSync(evilMarker)).toBe(false);
      expect(fs.readFileSync(githubPath, 'utf8')).toBe(path.dirname(trustedNode) + '\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects Node/npm shims before accepting a standard trusted toolchain', () => {
    const action = fs.readFileSync(actionPath, 'utf8');
    const resolverRun = (YAML.parse(action) as {
      runs?: { steps?: Array<{ id?: string; run?: string }> };
    }).runs?.steps?.find((step) => step.id === 'trusted_toolchain')?.run;
    expect(resolverRun).toBeTruthy();

    const resolverStart = (resolverRun as string).indexOf('workspace_root=');
    const resolverEnd = (resolverRun as string).indexOf('\nnode_realpath=', resolverStart);
    expect(resolverStart).toBeGreaterThanOrEqual(0);
    expect(resolverEnd).toBeGreaterThan(resolverStart);
    const resolverSource = (resolverRun as string).slice(resolverStart, resolverEnd)
      .split('\n')
      .map((line) => line.startsWith('        ') ? line.slice(8) : line)
      .join('\n');

    const repoRoot = path.resolve(path.dirname(actionPath), '../../..');
    const root = mkdtempSync(path.join(path.dirname(repoRoot), 'haiku-codex-node-trust-'));
    const trustedRoot = path.join(root, 'trusted-bin');
    const workspace = path.join(root, 'workspace');
    const actionDir = path.join(root, 'action');
    const runnerTemp = path.join(root, 'runner-temp');
    const tmpEvil = mkdtempSync(path.join(tmpdir(), 'haiku-codex-node-tmp-evil-'));
    const roots = [workspace, actionDir, runnerTemp, tmpEvil];
    for (const directory of roots) fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(trustedRoot, { recursive: true, mode: 0o755 });
    chmodSync(trustedRoot, 0o755);
    const trustedNode = path.join(trustedRoot, 'node');
    copyFileSync(process.execPath, trustedNode);
    chmodSync(trustedNode, 0o755);
    writeFileSync(path.join(trustedRoot, 'npm-cli.js'), 'process.stdout.write("11.0.0\\n");\n');
    chmodSync(path.join(trustedRoot, 'npm-cli.js'), 0o755);
    symlinkSync('npm-cli.js', path.join(trustedRoot, 'npm'));

    const trustedRootQuoted = trustedRoot.replaceAll("'", "'\\''");
    const trustedResolverSource = resolverSource.replace(
      'for trusted_root in /usr /usr/local /bin /opt/hostedtoolcache /opt/runner /opt/homebrew; do',
      `for trusted_root in '${trustedRootQuoted}'; do`,
    );
    try {
      for (const maliciousDir of roots) {
        const maliciousNode = path.join(maliciousDir, 'node');
        writeFileSync(maliciousNode, '#!/bin/sh\nexit 97\n');
        chmodSync(maliciousNode, 0o755);
        const maliciousNpm = path.join(maliciousDir, 'npm');
        writeFileSync(maliciousNpm, '#!/bin/sh\nexit 97\n');
        chmodSync(maliciousNpm, 0o755);
        const script = [
          'set -euo pipefail',
          trustedResolverSource,
          'selected_node="$(find_trusted_node)"',
          'selected_npm="$(find_trusted_npm)"',
          'printf "%s\\n%s\\n" "$selected_node" "$selected_npm"',
        ].join('\n');
        const selected = execFileSync('/bin/bash', ['-c', script], {
          encoding: 'utf8',
          env: {
            PATH: `${maliciousDir}:${trustedRoot}:/usr/bin:/bin`,
            GITHUB_WORKSPACE: workspace,
            CODEX_ACTION_PATH: actionDir,
            RUNNER_TEMP: runnerTemp,
          },
        }).trim().split('\n');
        expect(selected[0], `resolver selected malicious Node from ${maliciousDir}`).toBe(trustedNode);
        expect(selected[1], `resolver selected malicious npm from ${maliciousDir}`).toBe(path.join(trustedRoot, 'npm-cli.js'));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(tmpEvil, { recursive: true, force: true });
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
    expect(action).toContain('TRUSTED_NODE: ${{ steps.trusted_toolchain.outputs.node_realpath }}');
    expect(action).toContain('node_bin="${TRUSTED_NODE:-}"');
    expect(action).not.toContain('node_bin="$(command -v node || true)"');
    expect(action).toContain('--ttl-ms 1800000');
    expect(action).not.toContain('--ttl-ms 25200000');
    expect(action).not.toContain('CODEX_AUTH_BROKER_SOCKET=');
    expect(action).not.toContain('CODEX_AUTH_FILE=');
    expect(action).not.toContain('CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}');
  });
});
