import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

const actionPath = path.resolve(process.cwd(), '.github/actions/setup-claude-haiku-fallback/action.yml');

function brokerStepScript() {
  const document = YAML.parse(fs.readFileSync(actionPath, 'utf8')) as {
    runs?: { steps?: Array<{ id?: string; run?: string }> };
  };
  return document.runs?.steps?.find((step) => step.id === 'start_codex_auth_broker')?.run ?? '';
}

/**
 * Esegue il VERO step `start_codex_auth_broker` con un Node finto: uno script
 * che consuma lo stdin (la FIFO della credenziale), registra i propri argomenti
 * ed esce. Se il marker esiste, lo step ha accettato il runtime e ha lanciato
 * il broker con quel binario; il broker finto non apre il socket, quindi lo
 * step chiude con "did not become ready" senza toccare nulla fuori da runnerTemp.
 */
function runBrokerStep(runnerTemp: string, nodeBin: string, nodeSha256 = sha256(nodeBin)) {
  const outputFile = path.join(runnerTemp, 'github-output');
  fs.writeFileSync(outputFile, '');
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', brokerStepScript()], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: '/usr/bin:/bin',
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: outputFile,
      GITHUB_ACTION_PATH: path.dirname(actionPath),
      CODEX_AUTH_JSON: '{"access_token":"step-test"}',
      CODEX_CLI_BIN: path.join(runnerTemp, 'codex-luna-max-codex-cli.fixture/codex.js'),
      CODEX_CLI_REALPATH: path.join(runnerTemp, 'codex-luna-max-codex-cli.fixture/codex.js'),
      CODEX_CLI_SHA256: '0'.repeat(64),
      CODEX_CLI_PREFIX: path.join(runnerTemp, 'codex-luna-max-codex-cli.fixture'),
      TRUSTED_NODE: nodeBin,
      TRUSTED_NODE_SHA256: nodeSha256,
    },
  });
  return { ...result, log: `${result.stdout}${result.stderr}` };
}

function sha256(file: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeFakeNode(runnerTemp: string, relativeBin: string, marker: string) {
  const nodeBin = path.join(runnerTemp, relativeBin);
  fs.mkdirSync(path.dirname(nodeBin), { recursive: true, mode: 0o700 });
  fs.writeFileSync(nodeBin, `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' "$@" > '${marker}'\n`);
  fs.chmodSync(nodeBin, 0o700);
  return nodeBin;
}

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
    const gate = steps.find((step) => step.name === 'Resolve Codex Luna Max article gate')?.run ?? '';
    const resolver = steps.find((step) => step.id === 'trusted_toolchain')?.run ?? '';
    const install = steps.find((step) => step.id === 'install_codex_cli')?.run ?? '';
    expect(gate).toContain('resolved_gate="${ENABLE_CODEX_ARTICLE_FALLBACK:-${ENABLE_HAIKU_ARTICLE_FALLBACK:-1}}"');
    expect(gate).toContain('ENABLE_CODEX_ARTICLE_FALLBACK=$resolved_gate');
    expect(gate).not.toContain('ENABLE_CODEX_ARTICLE_FALLBACK=0');
    expect(resolver).toContain('report_runtime_candidates()');
    expect(resolver).toContain('path_components_trusted');
    expect(resolver).toContain('node_version=');
    expect(resolver).toContain('node_archive_sha256=');
    // Download limitato: senza tetto un nodejs.org appeso blocca lo step fino
    // al timeout del job (post-merge-followup run 35735836333, 32 minuti).
    expect(resolver).toMatch(/\/usr\/bin\/curl [^\n]*\\\n\s+--connect-timeout \d+ --max-time \d+ --retry \d+/);
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

  describe.skipIf(process.platform !== 'linux')('broker step with the checksum-pinned Node runtime', () => {
    const roots: string[] = [];
    afterEach(() => {
      for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    });
    const runnerTempFixture = () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-broker-step-')));
      roots.push(root);
      return root;
    };

    // Smoke-test-ai-models run 35995800618: TRUSTED_NODE era
    // $RUNNER_TEMP/codex-luna-max-node.b3OZMc/node/bin/node e lo step rispondeva
    // "could not use its attested Node runtime" a ogni run.
    it('starts the broker with the pinned runtime extracted by trusted_toolchain', () => {
      const runnerTemp = runnerTempFixture();
      const marker = path.join(runnerTemp, 'broker-launched');
      const runtimeRoot = path.join(runnerTemp, 'codex-luna-max-node.b3OZMc');
      const nodeBin = writeFakeNode(runnerTemp, 'codex-luna-max-node.b3OZMc/node/bin/node', marker);
      fs.chmodSync(runtimeRoot, 0o700);
      const result = runBrokerStep(runnerTemp, nodeBin);
      expect(result.status, result.log).toBe(0);
      expect(result.log).not.toContain('could not use its attested Node runtime');
      expect(fs.readFileSync(marker, 'utf8').split('\n')[0]).toBe(
        path.join(path.dirname(actionPath), 'codex-auth-broker.mjs'),
      );
    });

    it.each([
      ['a sibling directory of RUNNER_TEMP', 'elsewhere/node/bin/node'],
      ['a nested path under the pinned runtime', 'codex-luna-max-node.b3OZMc/extra/node/bin/node'],
      ['a non-mktemp runtime name', 'codex-luna-max-node.b3OZ/node/bin/node'],
    ])('keeps refusing a Node runtime in %s', (_label, relativeBin) => {
      const runnerTemp = runnerTempFixture();
      const marker = path.join(runnerTemp, 'broker-launched');
      const nodeBin = writeFakeNode(runnerTemp, relativeBin, marker);
      fs.chmodSync(path.join(runnerTemp, relativeBin.split('/')[0]), 0o700);
      const result = runBrokerStep(runnerTemp, nodeBin);
      expect(result.status, result.log).toBe(0);
      expect(result.log).toContain('could not use its attested Node runtime');
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('refuses a pinned runtime directory that is not private (0700)', () => {
      const runnerTemp = runnerTempFixture();
      const marker = path.join(runnerTemp, 'broker-launched');
      const nodeBin = writeFakeNode(runnerTemp, 'codex-luna-max-node.b3OZMc/node/bin/node', marker);
      fs.chmodSync(path.join(runnerTemp, 'codex-luna-max-node.b3OZMc'), 0o755);
      const result = runBrokerStep(runnerTemp, nodeBin);
      expect(result.log).toContain('could not use its attested Node runtime');
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('still binds the pinned runtime to the attested sha256', () => {
      const runnerTemp = runnerTempFixture();
      const marker = path.join(runnerTemp, 'broker-launched');
      const nodeBin = writeFakeNode(runnerTemp, 'codex-luna-max-node.b3OZMc/node/bin/node', marker);
      fs.chmodSync(path.join(runnerTemp, 'codex-luna-max-node.b3OZMc'), 0o700);
      const result = runBrokerStep(runnerTemp, nodeBin, 'f'.repeat(64));
      expect(result.log).toContain('changed after attestation');
      expect(fs.existsSync(marker)).toBe(false);
    });
  });
});
