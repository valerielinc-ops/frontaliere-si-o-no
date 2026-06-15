import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfHot404BridgePlugin } from '../build-plugins/cfHot404BridgePlugin';

/**
 * The plugin resolves paths via resolveSearchConsoleCompatTarget (reads
 * data/jobs.json, assembled in the CI gate before vitest). These assertions
 * cover the bounded-recovery invariants:
 *   - hot-list non-Ticino job paths get a recovered noindex bridge,
 *   - an already-emitted richer page is never overwritten (gap-fill),
 *   - the hard MAX_EMIT cap bounds the page count regardless of list size.
 */
describe('cfHot404BridgePlugin', () => {
  let tmp: string;

  const hot = {
    generatedAt: '2026-06-15T00:00:00.000Z',
    source: 'cloudflare',
    paths: [
      { path: '/cerca-lavoro-argovia/recovered-non-ti-role-acme-aarau', hits: 9 },
      { path: '/en/find-jobs-zurich/recovered-non-ti-role-acme-zurich', hits: 7 },
      { path: '/cerca-lavoro-zurigo/preexisting-richer-role', hits: 5 },
    ],
  };

  const rel = (p: string) => p.replace(/^\//, '') + '/index.html';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-hot-'));
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'data', 'cf-hot-404s.json'), JSON.stringify(hot));
    // Pre-existing richer page the gap-fill guard must preserve.
    const preDir = path.join(tmp, 'dist', 'cerca-lavoro-zurigo', 'preexisting-richer-role');
    fs.mkdirSync(preDir, { recursive: true });
    fs.writeFileSync(path.join(preDir, 'index.html'), '<html>RICHER</html>');

    const plugin = cfHot404BridgePlugin(tmp);
    await (plugin.closeBundle as () => Promise<void>)();
  });

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('recovers a hot non-Ticino job path as a noindex canonical bridge', () => {
    const file = path.join(tmp, 'dist', rel('/cerca-lavoro-argovia/recovered-non-ti-role-acme-aarau'));
    expect(fs.existsSync(file)).toBe(true);
    const html = fs.readFileSync(file, 'utf-8');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('noindex');
  });

  it('recovers a hot path in a non-default locale (EN)', () => {
    const file = path.join(tmp, 'dist', rel('/en/find-jobs-zurich/recovered-non-ti-role-acme-zurich'));
    expect(fs.existsSync(file)).toBe(true);
  });

  it('never overwrites an already-emitted richer page (gap-fill)', () => {
    const file = path.join(tmp, 'dist', rel('/cerca-lavoro-zurigo/preexisting-richer-role'));
    expect(fs.readFileSync(file, 'utf-8')).toBe('<html>RICHER</html>');
  });
});
