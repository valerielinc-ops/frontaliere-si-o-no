import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/lib/promote-cdn-live-marker.sh');

function run(args: string[], env: Record<string, string>): { code: number; output: string } {
  try {
    return {
      code: 0,
      output: execFileSync('bash', [SCRIPT, ...args], {
        env: { PATH: process.env.PATH ?? '', ...env },
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error: unknown) {
    const result = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      code: result.status ?? 1,
      output: `${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`,
    };
  }
}

function buildFiles(siteId: string, expectedId: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-live-marker-'));
  const site = join(dir, 'site-build-id.txt');
  const expected = join(dir, 'build-id.txt');
  writeFileSync(site, `${siteId}\n`);
  writeFileSync(expected, `${expectedId}\n`);
  return { dir, site, expected };
}

describe('post-validation CDN live-marker promotion', () => {
  it('fails closed when Pages is still older than the build being promoted', () => {
    const files = buildFiles('1789466830893', '1789477560067');
    const result = run([files.expected], {
      SITE_BUILD_ID_URL: `file://${files.site}`,
      CDN_TARGET: 'pages',
    });
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/refusing promotion/);
  });

  it('does not move a marker backwards when a newer Pages build won the race', () => {
    const files = buildFiles('1789477560067', '1789466830893');
    const result = run([files.expected], {
      SITE_BUILD_ID_URL: `file://${files.site}`,
      CDN_TARGET: 'pages',
    });
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/site already serves newer build/);
  });

  it('rejects an unknown publish target before touching the CDN', () => {
    const files = buildFiles('1789477560067', '1789477560067');
    const result = run([files.expected], {
      SITE_BUILD_ID_URL: `file://${files.site}`,
      CDN_TARGET: 'unknown',
    });
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/unsupported CDN_TARGET/);
  });

  it('keeps readiness and live publication as separate workflow contracts', () => {
    const prep = readFileSync(resolve('scripts/lib/deploy-it-pages-prep.sh'), 'utf8');
    const gate = readFileSync(resolve('scripts/lib/wait-cdn-build-id.sh'), 'utf8');
    const publish = readFileSync(resolve('.github/workflows/deploy-publish.yml'), 'utf8');
    expect(prep).toContain('$CDN_READY_BUILD_ID_FILE');
    expect(prep).toContain('$CDN_LIVE_BUILD_ID_FILE');
    expect(gate).toContain('${CDN_READY_BUILD_ID_FILE}');
    expect(publish).toContain('needs: [deploy, validate-live]');
    expect(publish).toContain('promote-cdn-live-marker.sh sitemaps-bundle/build-id.txt');
  });
});
