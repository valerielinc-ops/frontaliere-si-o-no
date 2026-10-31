/** Official Codex rust-v0.153.4 catalogue, restricted only for concierge JSON.
 * Source commit 3d2ee51ca2d5db578f328aa75e20aa22c0197c9a; models.json Git
 * blob 698da6fb7a825cd3ede1696e4ce8579ef5c42c02 (Apache-2.0 upstream).
 * The adjacent source preserves the unique model entry without capability edits.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const source = new URL('./concierge-model-source.json', import.meta.url);
const SOURCE_HASH = 'cca54e0c9ae538086afcb7655a69eb7800e9ab20e1f58814d11c2fedea05ea14';
const hash = data => createHash('sha256').update(data).digest('hex');
const DISABLED = Object.freeze(['js_repl', 'code_mode', 'code_mode_only', 'multi_agent_v2', 'request_permissions_tool',
  'deferred_executor', 'token_budget', 'current_time_reminder', 'tool_search']);
export const FUNCTION_PROFILE_DISABLED_FEATURES = Object.freeze([
  'shell_tool', 'unified_exec', 'multi_agent', 'image_generation', 'browser_use',
  'computer_use', 'apps', 'plugins', 'view_image', 'goals', 'sleep_tool',
  'tool_suggest', 'skill_search',
]);

/** Resolve the native executable selected by the official 0.153.4 launcher;
 * hashing only codex.js would not attest the binary which actually runs. */
export function resolvePinnedCodexNative(prefix, { platform = process.platform, arch = process.arch } = {}) {
  if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('concierge_native_platform_unsupported');
  const root = fs.realpathSync(prefix);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@openai/codex/package.json'), 'utf8'));
  const packageRoot = path.join(root, `node_modules/@openai/codex-${platform}-${arch}`);
  const nativeMetadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (metadata.version !== '0.153.4' || nativeMetadata.version !== `0.153.4-${platform}-${arch}`) throw new Error('concierge_native_pin_mismatch');
  const triple = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  const native = path.join(packageRoot, 'vendor', triple, 'bin/codex'); const stat = fs.lstatSync(native);
  const real = fs.realpathSync(native);
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111) || !real.startsWith(`${root}${path.sep}`)) throw new Error('concierge_native_path_invalid');
  return real;
}

export function prepareConciergeTools(directory, model) {
  const raw = fs.readFileSync(source);
  if (hash(raw) !== SOURCE_HASH) throw new Error('concierge_catalogue_source_changed');
  const data = JSON.parse(raw);
  if (data.models?.length !== 1 || data.models[0].slug !== model) throw new Error('concierge_catalogue_model_mismatch');
  const original = data.models[0];
  const catalogue = { models: [{ ...original, shell_type: 'disabled', apply_patch_tool_type: null,
    experimental_supported_tools: [], tool_mode: 'direct', node_repl_disabled: true, supports_search_tool: false }] };
  const target = path.join(directory, 'concierge-model-catalogue.json');
  const contents = JSON.stringify(catalogue);
  fs.writeFileSync(target, contents, { mode: 0o400, flag: 'wx' });
  const expected = hash(contents);
  return {
    assert() {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o400 || hash(fs.readFileSync(target)) !== expected) {
        throw new Error('concierge_catalogue_attestation_failed');
      }
    },
    args: ['-c', `model_catalog_json=${JSON.stringify(target)}`,
      '-c', 'agents.enabled=false',
      '-c', 'tools.update_plan.enabled=false', '-c', 'tools.experimental_request_user_input.enabled=false',
      ...DISABLED.flatMap(feature => ['--disable', feature])],
  };
}
