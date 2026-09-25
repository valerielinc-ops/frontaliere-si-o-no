import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveTranslationRuntimeContractV2,
  TRANSLATION_RUNTIME_CONTRACT_V2,
  validateTranslationRuntimeContractV2,
} from '../scripts/lib/translation-runtime-contract-v2.mjs';
import { runTranslationScheduleV2 } from '../scripts/translation-schedule-run-v2.mjs';

const temporaryRoots: string[] = [];

function contractWithProvider(changes: Record<string, unknown>) {
  return {
    ...TRANSLATION_RUNTIME_CONTRACT_V2,
    provider: { ...TRANSLATION_RUNTIME_CONTRACT_V2.provider, ...changes },
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('translation runtime contract v2', () => {
  it('pins the zero-cost isolated provider seam and disables writers', () => {
    expect(TRANSLATION_RUNTIME_CONTRACT_V2).toMatchObject({
      schemaVersion: 2,
      provider: {
        modulePath: 'scripts/lib/translation-shadow-provider-v2.mjs',
        exportName: 'translate',
        schemaVersion: 3,
        engineVersion: 'shadow-engine-v2',
        costClass: 'zero',
        executionClass: 'isolated_callback',
      },
      capabilities: { generationEnabled: false, publishEnabled: false },
    });
    expect(Object.isFrozen(TRANSLATION_RUNTIME_CONTRACT_V2)).toBe(true);
    expect(Object.isFrozen(TRANSLATION_RUNTIME_CONTRACT_V2.provider)).toBe(true);
    expect(Object.isFrozen(TRANSLATION_RUNTIME_CONTRACT_V2.capabilities)).toBe(true);
  });

  it.each([
    ['modulePath', 'scripts/lib/other-provider.mjs'],
    ['exportName', 'otherExport'],
    ['schemaVersion', 2],
    ['engineVersion', 'other-engine-v2'],
  ])('rejects a discordant provider %s before runtime resolution', (field, value) => {
    expect(() => validateTranslationRuntimeContractV2(contractWithProvider({ [field]: value })))
      .toThrow(TypeError);
  });

  it.each([
    ['modulePath'],
    ['exportName'],
    ['schemaVersion'],
    ['engineVersion'],
  ])('rejects a missing provider %s before runtime resolution', (field) => {
    const provider = { ...TRANSLATION_RUNTIME_CONTRACT_V2.provider };
    Reflect.deleteProperty(provider, field);
    expect(() => validateTranslationRuntimeContractV2({
      ...TRANSLATION_RUNTIME_CONTRACT_V2,
      provider,
    })).toThrow(TypeError);
  });

  it('rejects any generation or publish capability before the executor can run', () => {
    expect(() => validateTranslationRuntimeContractV2({
      ...TRANSLATION_RUNTIME_CONTRACT_V2,
      capabilities: { generationEnabled: true, publishEnabled: false },
    })).toThrow(TypeError);
    expect(() => validateTranslationRuntimeContractV2({
      ...TRANSLATION_RUNTIME_CONTRACT_V2,
      capabilities: { generationEnabled: false, publishEnabled: true },
    })).toThrow(TypeError);
  });

  it('probes the pinned export and fails before an executor/provider call when it is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'translation-runtime-contract-v2-'));
    temporaryRoots.push(root);
    const modulePath = join(root, 'scripts/lib/translation-shadow-provider-v2.mjs');
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    writeFileSync(modulePath, 'export function notTranslate() {}\n');

    await expect(resolveTranslationRuntimeContractV2({ repository: root }))
      .rejects.toThrow(/provider export is missing/u);
  });

  it('resolves the source-controlled module and returns a stable contract digest', async () => {
    const resolved = await resolveTranslationRuntimeContractV2({ repository: process.cwd() });

    expect(resolved.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(resolved.provider.moduleUrl).toMatch(/translation-shadow-provider-v2\.mjs$/u);
    expect(resolved.provider.exportName).toBe('translate');
    expect(resolved.provider.schemaVersion).toBe(3);
    expect(resolved.provider.engineVersion).toBe('shadow-engine-v2');
    expect(resolved.capabilities).toEqual({ generationEnabled: false, publishEnabled: false });
  });

  it('rejects legacy mutable provider options before the scheduler can call a provider', async () => {
    await expect(runTranslationScheduleV2({
      repository: process.cwd(),
      providerModule: 'scripts/lib/other-provider.mjs',
    } as never)).rejects.toThrow(/pinned by the runtime contract/u);
  });
});
