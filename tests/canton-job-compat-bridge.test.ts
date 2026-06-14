import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cantonJobCompatBridgePlugin } from '../build-plugins/cantonJobCompatBridgePlugin';

/**
 * The plugin resolves paths via resolveSearchConsoleCompatTarget, which reads
 * data/jobs.json (assembled in the CI gate before vitest). These assertions
 * cover the GAP-FILL invariants that must hold regardless of which exact
 * canton a slug resolves to:
 *   - non-Ticino canton job paths get a recovered bridge page,
 *   - Ticino + nationwide paths are left to jobsSeoPagesPlugin (not emitted),
 *   - an already-emitted (enriched) page is never overwritten,
 *   - nested city/company hub paths are not turned into job bridges.
 */
describe('cantonJobCompatBridgePlugin', () => {
  let tmp: string;

  const compatPaths = [
    '/cerca-lavoro-argovia/recovered-non-ti-role-acme-aarau',          // non-TI → emit
    '/en/find-jobs-zurich/recovered-non-ti-role-acme-zurich',          // non-TI (EN) → emit
    '/cerca-lavoro-ticino/ti-owned-should-be-skipped',                 // TI → jobsSeoPagesPlugin owns it
    '/cerca-lavoro-svizzera/aggregate-should-be-skipped',              // nationwide → skipped
    '/cerca-lavoro-zurigo/preexisting-enriched-role',                  // non-TI but page already exists → skip
    '/cerca-lavoro-grigioni/coira/azienda-rhb',                        // nested hub (2 segments) → skip
  ];

  const rel = (p: string) => p.replace(/^\//, '') + '/index.html';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-bridge-'));
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'data', 'seo-404-compat-paths.json'),
      JSON.stringify({ paths: compatPaths }),
    );
    // Pre-existing enriched page that the gap-fill guard must preserve.
    const preDir = path.join(tmp, 'dist', 'cerca-lavoro-zurigo', 'preexisting-enriched-role');
    fs.mkdirSync(preDir, { recursive: true });
    fs.writeFileSync(path.join(preDir, 'index.html'), '<html>ENRICHED</html>');

    const plugin = cantonJobCompatBridgePlugin(tmp);
    // closeBundle is declared on the plugin object; invoke it directly.
    await (plugin.closeBundle as () => Promise<void>)();
  });

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('recovers a non-Ticino canton job path as a noindex canonical bridge', () => {
    const file = path.join(tmp, 'dist', rel('/cerca-lavoro-argovia/recovered-non-ti-role-acme-aarau'));
    expect(fs.existsSync(file)).toBe(true);
    const html = fs.readFileSync(file, 'utf-8');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('noindex');
  });

  it('recovers a non-Ticino path in a non-default locale (EN)', () => {
    const file = path.join(tmp, 'dist', rel('/en/find-jobs-zurich/recovered-non-ti-role-acme-zurich'));
    expect(fs.existsSync(file)).toBe(true);
  });

  it('leaves Ticino job paths to jobsSeoPagesPlugin (no bridge emitted)', () => {
    const file = path.join(tmp, 'dist', rel('/cerca-lavoro-ticino/ti-owned-should-be-skipped'));
    expect(fs.existsSync(file)).toBe(false);
  });

  it('does not emit for the nationwide aggregate board', () => {
    const file = path.join(tmp, 'dist', rel('/cerca-lavoro-svizzera/aggregate-should-be-skipped'));
    expect(fs.existsSync(file)).toBe(false);
  });

  it('never overwrites an already-emitted enriched page', () => {
    const file = path.join(tmp, 'dist', rel('/cerca-lavoro-zurigo/preexisting-enriched-role'));
    expect(fs.readFileSync(file, 'utf-8')).toBe('<html>ENRICHED</html>');
  });

  it('skips nested city/company hub paths (more than one segment after the section)', () => {
    const file = path.join(tmp, 'dist', rel('/cerca-lavoro-grigioni/coira/azienda-rhb'));
    expect(fs.existsSync(file)).toBe(false);
  });
});
