/** Offline fake provider only. Never receives real auth or candidate material. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { prepareConciergeTools, FUNCTION_PROFILE_DISABLED_FEATURES } from './concierge-tools.mjs';
import { brokerPermissionConfig } from './broker-permissions.mjs';
import { CODEX_FALLBACK_MODEL, CODEX_FALLBACK_EFFORT } from '../../../scripts/lib/codex-fallback-contract.mjs';
import { isInvokedDirectly } from '../../../scripts/lib/is-invoked-directly.mjs';

export async function probeConciergeTools({ cli, temporary, assertRuntime = () => {}, onCapture = () => {} }) {
  const root = fs.mkdtempSync(path.join(temporary, 'concierge-tools-probe-')); fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home'); const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.writeFileSync(path.join(home, 'config.toml'), brokerPermissionConfig(), { mode: 0o600 });
  const catalogue = prepareConciergeTools(root, CODEX_FALLBACK_MODEL);
  const sideEffect = path.join(workspace, 'forbidden-side-effect');
  const captures = []; let child; let stderr = ''; let invalid = false;
  const server = http.createServer((request, response) => {
    let input = ''; request.setTimeout(3000, () => request.destroy());
    request.on('data', chunk => { input += chunk; if (Buffer.byteLength(input) > 1024 * 1024) request.destroy(); });
    request.on('end', () => {
      let body; try { body = JSON.parse(input); } catch { invalid = true; response.writeHead(400).end(); return; }
      const embeddedTools = Array.isArray(body.input) ? body.input.filter(item => item.type === 'additional_tools') : [];
      onCapture({ path: request.url, liteHeader: request.headers['x-openai-internal-codex-responses-lite'],
        reasoningContext: body.reasoning?.context, embeddedToolCounts: embeddedTools.map(item => item.tools?.length),
        embeddedToolNames: embeddedTools.flatMap(item => Array.isArray(item.tools) ? item.tools.map(tool => tool.name || tool.type) : []) });
      if (captures.length >= 4 || request.url !== '/v1/responses' || !Array.isArray(body.input)
        || request.headers['x-openai-internal-codex-responses-lite'] !== 'true' || body.reasoning?.context !== 'all_turns'
        || embeddedTools.length !== 1 || body.input[0]?.type !== 'additional_tools'
        || embeddedTools.some(item => !Array.isArray(item.tools) || item.tools.length)
        || (Object.hasOwn(body, 'tools') && (!Array.isArray(body.tools) || body.tools.length))) {
        invalid = true; response.writeHead(400).end(); return;
      }
      const previous = JSON.stringify(body.input);
      captures.push({ noTools: !body.tools?.length && embeddedTools.every(item => item.tools.length === 0),
        lite: true, toolsFieldOmitted: !Object.hasOwn(body, 'tools'),
        shellRejected: previous.includes('unsupported call: exec_command'), patchRejected: previous.includes('unsupported custom tool call: apply_patch') });
      const item = captures.length === 1
        ? { type: 'function_call', id: 'fc_probe', call_id: 'shell_probe', name: 'exec_command', arguments: JSON.stringify({ cmd: `touch ${sideEffect}; sleep 1` }) }
        : captures.length === 2
          ? { type: 'custom_tool_call', id: 'ct_probe', call_id: 'patch_probe', name: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${sideEffect}\n+forbidden\n*** End Patch` }
          : { type: 'message', id: 'msg_probe', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}' }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
      emit({ type: 'response.created', response: { id: 'resp_probe', object: 'response', created_at: 0, status: 'in_progress', output: [] } });
      emit({ type: 'response.output_item.added', output_index: 0, item });
      emit({ type: 'response.output_item.done', output_index: 0, item });
      emit({ type: 'response.completed', response: { id: 'resp_probe', object: 'response', created_at: 0, status: 'completed', output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      response.end();
    });
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const args = ['exec', '--ephemeral', '--strict-config', '--ignore-rules', '--cd', workspace, '--skip-git-repo-check',
      '--model', CODEX_FALLBACK_MODEL, '-c', `model_reasoning_effort=${JSON.stringify(CODEX_FALLBACK_EFFORT)}`,
      '-c', 'model_provider="fixture"', '-c', `model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",env_key="SYNTHETIC_API_KEY",request_max_retries=0,stream_max_retries=0}`,
      ...FUNCTION_PROFILE_DISABLED_FEATURES.flatMap(feature => ['--disable', feature]), ...catalogue.args, '-'];
    assertRuntime(); catalogue.assert();
    child = spawn(cli, args, { cwd: workspace, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CODEX_HOME: home,
      OPENSSL_CONF: '/dev/null', SYNTHETIC_API_KEY: 'fixture-only-not-a-credential' }, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); }); child.stdin.on('error', () => {});
    child.stdin.end('Return exactly {"ok":true}. Synthetic offline capability test.');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try { await once(child, 'exit'); } finally { clearTimeout(timer); }
    onCapture({ exitCode: child.exitCode, captures, sideEffect: fs.existsSync(sideEffect),
      unsupportedDiagnostics: stderr.split('\n').filter(line => line.includes('unsupported')).map(line => line.slice(line.indexOf('unsupported'))) });
    if (invalid || child.exitCode !== 0 || captures.length !== 3 || !captures.every(item => item.noTools)
      || !captures[1].shellRejected || !captures[2].patchRejected || fs.existsSync(sideEffect)
      || !stderr.includes('unsupported call: exec_command') || !stderr.includes('unsupported custom tool call: apply_patch')) {
      throw new Error('concierge_tool_capability_probe_failed');
    }
    return { toolsEmpty: true, toolsFieldOmitted: captures.every(item => item.toolsFieldOmitted),
      shellCallRejected: true, patchCallRejected: true, sideEffectsAbsent: true, provider: 'offline_fixture', transport: 'responses',
      responsesLiteSerializationCertified: true, productionChatgptAuthenticationCertified: false };
  } finally {
    child?.kill('SIGKILL'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (isInvokedDirectly(import.meta.url)) {
  await probeConciergeTools({ cli: process.argv[2], temporary: process.argv[3] });
  console.log('concierge JSON tool capability preflight passed');
}
