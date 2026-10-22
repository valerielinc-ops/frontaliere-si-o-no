import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readTranslationDeployHandoff, writeTranslationDeployHandoff } from '../scripts/ci/translation-deploy-handoff.mjs';

describe('translation deploy handoff admission', () => {
  it('holds a pending tree and admits only the complete tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'translation-handoff-'));
    const filePath = join(root, 'handoff.json');

    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'unmarked', admitted: true });
    expect(writeTranslationDeployHandoff({ state: 'pending', filePath, runId: '101' })).toBe(true);
    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'pending', admitted: false });
    expect(writeTranslationDeployHandoff({ state: 'pending', filePath, runId: '102' })).toBe(false);
    expect(writeTranslationDeployHandoff({ state: 'complete', filePath, runId: '103' })).toBe(true);
    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'complete', admitted: true });
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({ state: 'complete', runId: '103' });
  });

  it('fails closed for malformed or unknown marker content', () => {
    const root = mkdtempSync(join(tmpdir(), 'translation-handoff-invalid-'));
    const filePath = join(root, 'handoff.json');
    writeFileSync(filePath, '{"state":"half-written"}\n', 'utf8');
    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'invalid', admitted: false });
    writeFileSync(filePath, '{not-json}\n', 'utf8');
    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'invalid', admitted: false });
  });

  it('wires the pending/complete marker around every translation publisher', () => {
    const files = [
      '.github/workflows/translate-pending-logic.yml',
      '.github/workflows/translate-pending.yml',
      '.github/corpus-workflows/translate-pending.yml',
    ].map((file) => readFileSync(resolve(file), 'utf8'));
    for (const workflow of files) {
      expect(workflow).toContain('TRANSLATION_DEPLOY_HANDOFF_STATE');
      expect(workflow).toContain('TRANSLATION_DEPLOY_HANDOFF_STATE=complete');
      expect(workflow).toContain('data/translation-deploy-handoff.json');
      expect(workflow).toContain('validate-translation-completeness.mjs');
    }
    const deploy = readFileSync(resolve('.github/workflows/deploy.yml'), 'utf8');
    expect(deploy).toContain('translation-deploy-handoff.mjs');
    expect(deploy).toContain('Reject an incomplete translation tree');
    expect(readFileSync(resolve('scripts/ci/rearm-deploy-build.mjs'), 'utf8'))
      .toContain('readTranslationDeployHandoff');
  });
});
