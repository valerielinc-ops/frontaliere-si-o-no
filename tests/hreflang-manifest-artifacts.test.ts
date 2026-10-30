import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { inspectHreflangManifestArtifacts } from '../scripts/ci/hreflang-manifest-artifacts.mjs';
import { serializeHreflangManifest } from '../scripts/lib/hreflang-index-manifest.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = YAML.parse(readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8'));
const STEPS = WORKFLOW.jobs['build-locale'].steps;
const LOCALES = ['it', 'en', 'de', 'fr'];
const artifact = (locale: string, id: number, options = {}) => ({
  id,
  name: `hreflang-index-manifest-${locale}-42-3`,
  expired: false,
  workflow_run: { id: 42 },
  ...options,
});
const complete = () => LOCALES.map((locale, index) => artifact(locale, index + 1));

describe('same-run hreflang artifact barrier', () => {
  it('accepts all four current artifacts across API pages and unrelated artifacts', () => {
    const all = complete();
    expect(inspectHreflangManifestArtifacts([
      { artifacts: [{ id: 99, name: 'unrelated-report' }, ...all.slice(0, 2)] },
      { artifacts: all.slice(2) },
    ], '42', '3')).toEqual({ complete: true, missing: [] });
  });

  it('does not treat old runs, old attempts, or prefix matches as the missing locale', () => {
    const rows = complete().slice(0, 3);
    rows.push(artifact('fr', 4, { name: 'hreflang-index-manifest-fr-41-3' }));
    rows.push(artifact('fr', 5, { name: 'hreflang-index-manifest-fr-42-2' }));
    rows.push(artifact('fr', 6, { name: 'hreflang-index-manifest-fr-42-3-extra' }));
    expect(inspectHreflangManifestArtifacts([{ artifacts: rows }], '42', '3'))
      .toEqual({ complete: false, missing: ['hreflang-index-manifest-fr-42-3'] });
  });

  it('keeps expired artifacts incomplete', () => {
    const rows = complete();
    rows[0].expired = true;
    expect(inspectHreflangManifestArtifacts([{ artifacts: rows }], '42', '3').missing)
      .toEqual(['hreflang-index-manifest-it-42-3']);
  });

  it('allows a repeated artifact ID at a pagination boundary but rejects ambiguous names', () => {
    const rows = complete();
    expect(inspectHreflangManifestArtifacts([
      { artifacts: rows.slice(0, 2) }, { artifacts: rows.slice(1) },
    ], '42', '3').complete).toBe(true);
    expect(() => inspectHreflangManifestArtifacts([
      { artifacts: [...rows, artifact('it', 99)] },
    ], '42', '3')).toThrow('ambiguous');
  });

  it('rejects contradictory run context and unreadable metadata', () => {
    expect(() => inspectHreflangManifestArtifacts([{ artifacts: [
      ...complete(), artifact('it', 1, { workflow_run: { id: 41 } }),
    ] }], '42', '3')).toThrow('foreign workflow run');
    expect(() => inspectHreflangManifestArtifacts([{ artifacts: [artifact('it', 1, { expired: undefined })] }], '42', '3'))
      .toThrow('invalid same-run');
    expect(() => inspectHreflangManifestArtifacts([{}], '42', '3')).toThrow('invalid artifact page');
    expect(() => inspectHreflangManifestArtifacts([], '42', '3')).toThrow('missing');
    expect(() => inspectHreflangManifestArtifacts([{ artifacts: [] }], '42', '0')).toThrow('positive');
  });

  it('returns distinct CLI statuses for complete, incomplete, and invalid responses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hreflang-artifact-cli-'));
    try {
      const input = join(dir, 'pages.json');
      const run = () => spawnSync(process.execPath, [join(ROOT, 'scripts/ci/hreflang-manifest-artifacts.mjs'), input, '42', '3']);
      writeFileSync(input, JSON.stringify([{ artifacts: complete() }]));
      expect(run().status).toBe(0);
      writeFileSync(input, JSON.stringify([{ artifacts: complete().slice(1) }]));
      expect(run().status).toBe(1);
      writeFileSync(input, '{truncated');
      expect(run().status).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('hreflang artifact workflow handoff', () => {
  it('uploads only its hidden JSON and downloads exact foreign artifacts into the manifest directory', () => {
    const upload = STEPS.find((step: any) => step.name === 'Save hreflang index manifest (${{ matrix.locale }})');
    expect(upload.uses).toBe('actions/upload-artifact@v7');
    expect(upload.with).toMatchObject({
      name: 'hreflang-index-manifest-${{ matrix.locale }}-${{ github.run_id }}-${{ github.run_attempt }}',
      path: '.cache/hreflang-index-manifest/${{ matrix.locale }}.json',
      'include-hidden-files': true,
      'if-no-files-found': 'error',
    });
    const barrier = STEPS.find((step: any) => step.name === 'Wait for complete same-run hreflang manifest set');
    expect(barrier.run).toContain('/actions/runs/${HREFlANG_RUN_ID}/artifacts?per_page=100');
    expect(barrier.run).toContain('--paginate --slurp');
    for (const locale of LOCALES) {
      const download = STEPS.find((step: any) => step.name === `Restore same-run hreflang index manifest (${locale})`);
      expect(download.uses).toBe('actions/download-artifact@v8');
      expect(download.if).toBe(`matrix.locale != '${locale}'`);
      expect(download.with).toMatchObject({
        name: `hreflang-index-manifest-${locale}-` + '${{ github.run_id }}-${{ github.run_attempt }}',
        path: '.cache/hreflang-index-manifest',
        'run-id': '${{ github.run_id }}',
      });
      expect(STEPS.indexOf(upload)).toBeLessThan(STEPS.indexOf(barrier));
      expect(STEPS.indexOf(barrier)).toBeLessThan(STEPS.indexOf(download));
    }
  });

  it.each(['valid', 'missing', 'truncated', 'foreign'])('executes the unchanged envelope guard on %s downloaded files', (kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'hreflang-artifact-guard-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      symlinkSync(join(ROOT, 'scripts/lib'), join(dir, 'scripts/lib'), 'dir');
      const manifests = join(dir, '.cache/hreflang-index-manifest');
      mkdirSync(manifests, { recursive: true });
      for (const locale of ['en', 'de', 'fr']) {
        if (kind === 'missing' && locale === 'en') continue;
        const text = serializeHreflangManifest({
          locale,
          entries: new Map([[`/${locale}/example/`, 'cluster']]),
          runId: kind === 'foreign' && locale === 'en' ? '41' : '42',
        });
        writeFileSync(join(manifests, `${locale}.json`), kind === 'truncated' && locale === 'en' ? text.slice(0, -5) : text);
      }
      const guard = STEPS.find((step: any) => step.id === 'verify-hreflang-index-manifest');
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', guard.run], {
        cwd: dir,
        env: { ...process.env, HREFlANG_BUILD_LOCALE: 'it', HREFlANG_RUN_ID: '42' },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(kind === 'valid' ? 0 : 1);
      const rewrite = STEPS.find((step: any) => step.id === 'hreflang-index-manifest');
      expect(rewrite.run).toContain('--require-foreign-manifests');
      expect(STEPS.indexOf(guard)).toBeLessThan(STEPS.indexOf(rewrite));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
