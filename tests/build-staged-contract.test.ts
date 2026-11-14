// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

describe('staged production build memory boundary', () => {
  it('routes build:ci through the two-process runner', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['build:ci']).toContain('scripts/ci/build-staged.mjs');
  });

  it('keeps the SPA graph in bundle and the SEO graph in ssg', () => {
    const config = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toContain("const corePlugins: Plugin[] = [");
    expect(config).toContain("const seoPlugins: Plugin[] = isFastBuild ? [] : [");
    expect(config).toContain("const finalOutputPlugins: Plugin[] = [");
    expect(config).toContain("buildStage === 'bundle'");
    expect(config).toContain("buildStage === 'ssg'");
    expect(config).toContain("input: path.resolve(__dirname, 'build-plugins/ssgStageEntry.ts')");
    expect(config).toContain('write: !isSsgStage');
  });

  it('merges stage telemetry instead of hiding the bundle peak', () => {
    const runner = fs.readFileSync(path.join(ROOT, 'scripts/ci/build-staged.mjs'), 'utf8');
    expect(runner).toContain("const stages = ['bundle', 'ssg'];");
    expect(runner).toContain('peakAnonMb: Math.max');
    expect(runner).toContain('await mergeManifests();');
    expect(runner).toContain('removeGeneratedFile(reportBase);');
    expect(runner).toContain("removeGeneratedFile(path.resolve(ROOT, 'content-manifest.tsv'));");
  });
});
