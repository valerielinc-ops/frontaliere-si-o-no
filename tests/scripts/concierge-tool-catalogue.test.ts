import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareConciergeTools } from '../../.github/actions/setup-claude-haiku-fallback/concierge-tools.mjs';

describe('pinned concierge capability catalogue', () => {
  it('removes only the six capability fields while preserving the model and Lite transport', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concierge-catalogue-'));
    try {
      const original = JSON.parse(fs.readFileSync('.github/actions/setup-claude-haiku-fallback/concierge-model-source.json', 'utf8')).models[0];
      const compiled = prepareConciergeTools(root, 'gpt-5.6-luna'); compiled.assert();
      const model = JSON.parse(fs.readFileSync(path.join(root, 'concierge-model-catalogue.json'), 'utf8')).models[0];
      const delta = Object.keys(original).filter(key => JSON.stringify(original[key]) !== JSON.stringify(model[key]));
      // experimental_supported_tools is already empty in the official source.
      expect(delta.sort()).toEqual(['apply_patch_tool_type', 'node_repl_disabled', 'shell_type', 'supports_search_tool', 'tool_mode']);
      expect(model).toMatchObject({ slug: 'gpt-5.6-luna', use_responses_lite: true, shell_type: 'disabled',
        apply_patch_tool_type: null, experimental_supported_tools: [], node_repl_disabled: true, supports_search_tool: false, tool_mode: 'direct' });
      expect(compiled.args).toContain('agents.enabled=false');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects a changed catalogue before a CLI can be spawned', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concierge-catalogue-'));
    try {
      const compiled = prepareConciergeTools(root, 'gpt-5.6-luna');
      const file = path.join(root, 'concierge-model-catalogue.json'); fs.chmodSync(file, 0o600); fs.writeFileSync(file, '{}');
      expect(() => compiled.assert()).toThrow('concierge_catalogue_attestation_failed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('does not substitute another model or expose its broader capabilities', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concierge-catalogue-'));
    try { expect(() => prepareConciergeTools(root, 'another-model')).toThrow('concierge_catalogue_model_mismatch'); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
