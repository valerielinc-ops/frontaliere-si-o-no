import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  NATIVE_AUTOMERGE_HELPER_FILES,
  NATIVE_AUTOMERGE_SOURCE_FILES,
  persistNativeAutoMergeEnvironment,
  validateNativeAutoMergeSource,
} from '../scripts/ci/native-automerge-source.mjs';

const WORKFLOW_FILES = [
  '../.github/workflows/enable-native-automerge.yml',
  '../.github/workflows/retry-native-automerge.yml',
];
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

function readWorkflow(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function readSourceFile(relativePath: string) {
  return readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');
}

function workflowSteps(source: string) {
  const parsed = YAML.parse(source) as {
    jobs?: Record<string, { steps?: Array<Record<string, unknown>> }>;
  };
  const job = Object.values(parsed.jobs ?? {})[0];
  return job?.steps ?? [];
}

function makeSourceFixture(overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-automerge-source-'));
  for (const file of NATIVE_AUTOMERGE_SOURCE_FILES) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, overrides[file] ?? (file.endsWith('.json') ? '{}' : 'export const fixture = true;\n'));
  }
  return root;
}

describe('native auto-merge source-loading contract', () => {
  it.each(WORKFLOW_FILES)('uses the same trusted main sparse checkout in %s', (relativePath) => {
    const source = readWorkflow(relativePath);
    const steps = workflowSteps(source);
    const checkout = steps.find((step) => step.uses === 'actions/checkout@v5');
    const validation = steps.find((step) => String(step.name).includes('Validate trusted native auto-merge source'));
    const gate = steps.find((step) => String(step.name).match(/(?:Enable|Retry) GitHub auto-merge|Retry bounded native auto-merge opt-in/u));

    expect(checkout).toBeTruthy();
    expect(checkout?.with).toMatchObject({
      repository: '${{ github.repository }}',
      ref: 'main',
      path: 'native-automerge-main',
      'fetch-depth': 1,
      filter: 'blob:none',
      'sparse-checkout-cone-mode': false,
      'persist-credentials': false,
    });
    const sparsePaths = String((checkout?.with as Record<string, unknown>)?.['sparse-checkout'] ?? '')
      .trim()
      .split(/\r?\n/u)
      .map((path) => path.trim())
      .filter(Boolean);
    expect(sparsePaths).toEqual(NATIVE_AUTOMERGE_SOURCE_FILES.map((file) => `/${file}`));

    expect(validation?.run).toContain('native-automerge-source.mjs');
    expect(validation?.run).not.toContain('gh api');
    expect(source).toContain('$NATIVE_AUTOMERGE_SOURCE_ROOT/scripts/load-rc-env.mjs');
    expect(gate?.run).toContain('cd "$NATIVE_AUTOMERGE_SOURCE_ROOT"');
    expect(source).not.toContain('NATIVE_AUTOMERGE_BOOTSTRAP_READY');
    expect(source).not.toMatch(/if:\s+env\.NATIVE_AUTOMERGE_/u);
    expect(source).not.toMatch(/contents\/.*\?ref=main/u);
    expect(source).not.toContain('needs-human');
    expect(source).not.toMatch(/human approval/iu);
  });

  it('covers the transitive runtime graph, including REST fallback, gate, and registry', () => {
    expect(NATIVE_AUTOMERGE_HELPER_FILES).toHaveLength(7);
    const loader = readSourceFile('scripts/load-rc-env.mjs');
    const gate = readSourceFile('scripts/ci/native-automerge-gate.mjs');
    const policy = readSourceFile('scripts/ci/review-test-policy.mjs');
    expect(loader).toContain('fetchTemplateViaRest');
    expect(loader).toContain('firebaseremoteconfig.googleapis.com');
    expect(loader).toContain("import('./lib/google-service-account-token.mjs')");
    expect(gate).toContain("from './lib/constants.mjs'");
    expect(gate).toContain("from './review-test-policy.mjs'");
    expect(gate).toContain("from './lib/fetchPrFiles.mjs'");
    expect(policy).toContain("from '../lib/loop-fleet-contract.mjs'");
    expect(policy).toContain("data/loop-fleet/loop-registry.json");
    expect(NATIVE_AUTOMERGE_SOURCE_FILES).toEqual(expect.arrayContaining([
      'scripts/load-rc-env.mjs',
      'scripts/lib/google-service-account-token.mjs',
      'scripts/ci/native-automerge-gate.mjs',
      'scripts/lib/loop-fleet-contract.mjs',
      'data/loop-fleet/loop-registry.json',
    ]));

    for (const file of NATIVE_AUTOMERGE_SOURCE_FILES.filter((path) => path.endsWith('.mjs'))) {
      const source = readSourceFile(file);
      const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/gu)]
        .map((match) => normalize(join(dirname(file), match[1])).replaceAll('\\', '/'));
      expect(NATIVE_AUTOMERGE_SOURCE_FILES).toEqual(expect.arrayContaining(imports));
    }
  });

  it('keeps the seven gate helpers explicit and validates the live source tree', () => {
    expect(NATIVE_AUTOMERGE_HELPER_FILES).toHaveLength(7);
    const validated = validateNativeAutoMergeSource(REPOSITORY_ROOT);
    expect(validated.files).toEqual(NATIVE_AUTOMERGE_SOURCE_FILES);
    expect(validated.helperDir).toMatch(/scripts\/ci$/u);
  });

  it('fails closed when a required helper is unavailable', () => {
    const root = makeSourceFixture();
    try {
      const missing = NATIVE_AUTOMERGE_HELPER_FILES[0];
      rmSync(join(root, missing));

      expect(() => validateNativeAutoMergeSource(root)).toThrow(/non disponibile/u);
      try {
        validateNativeAutoMergeSource(root);
      } catch (error) {
        expect(error).toMatchObject({
          code: 'ERR_NATIVE_AUTOMERGE_SOURCE_UNAVAILABLE',
          unavailable: [expect.objectContaining({ file: missing })],
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for an invalid helper and does not persist an incomplete environment', () => {
    const root = makeSourceFixture({
      [NATIVE_AUTOMERGE_HELPER_FILES[1]]: 'export const =;\n',
    });
    const envFile = join(root, 'github-env');
    try {
      expect(() => validateNativeAutoMergeSource(root)).toThrow(/non disponibile/u);
      expect(() => persistNativeAutoMergeEnvironment(null, envFile)).toThrow();
      expect(() => readFileSync(envFile, 'utf8')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists only paths from a fully validated source', () => {
    const root = makeSourceFixture();
    const envFile = join(root, 'github-env');
    try {
      const validated = validateNativeAutoMergeSource(root);
      persistNativeAutoMergeEnvironment(validated, envFile);
      expect(readFileSync(envFile, 'utf8')).toBe([
        `NATIVE_AUTOMERGE_SOURCE_ROOT=${validated.root}`,
        `NATIVE_AUTOMERGE_HELPER_DIR=${validated.helperDir}`,
        '',
      ].join('\n'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('propagates the validated source paths through GITHUB_ENV for later steps', () => {
    const root = makeSourceFixture();
    const envFile = join(root, 'github-env');
    try {
      execFileSync(process.execPath, [join(REPOSITORY_ROOT, 'scripts/ci/native-automerge-source.mjs')], {
        env: {
          ...process.env,
          GITHUB_ENV: envFile,
          NATIVE_AUTOMERGE_SOURCE_ROOT: root,
        },
        encoding: 'utf8',
      });
      const persisted = readFileSync(envFile, 'utf8');
      expect(persisted).toContain(`NATIVE_AUTOMERGE_HELPER_DIR=${root}/scripts/ci\n`);
      expect(persisted).toContain(`NATIVE_AUTOMERGE_SOURCE_ROOT=${root}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
