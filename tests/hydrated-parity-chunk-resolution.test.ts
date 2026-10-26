import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const script = path.join(process.cwd(), 'scripts', 'ci', 'check-hydrated-article-parity.mjs');

/**
 * How the hydrated-article parity gate locates the client chunks it must read.
 * Chunks that export names carry an interface hash in their filename, so the
 * gate needs the published chunk manifest. Falling back to the plain
 * `<name>.js` when the manifest is missing would read a retained OLDER
 * generation's file (it still answers 200) and could pass on a broken deploy —
 * the gate exists to be believed, so on an interface-addressed generation it
 * fails instead.
 */
describe('check-hydrated-article-parity: chunk resolution fails closed', () => {
  let server: http.Server;
  let origin = '';
  let manifest: { status: number; body: string } = { status: 404, body: '' };
  let entry = 'import{__vitePreload as m}from"./i18n.a56b3675.js";';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      if (pathname === '/assets/chunk-manifest.json') {
        res.writeHead(manifest.status, { 'content-type': 'application/json' });
        res.end(manifest.body);
        return;
      }
      if (pathname === '/assets/index-entry.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(entry);
        return;
      }
      res.writeHead(404);
      res.end('');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  async function gate(): Promise<{ code: number; output: string }> {
    try {
      const { stdout, stderr } = await run(
        process.execPath,
        [script, `--cdn=${origin}`, `--base=${origin}`, `--api=${origin}`],
        { timeout: 60_000 },
      );
      return { code: 0, output: `${stdout}${stderr}` };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  it('fails when the manifest is 404 on an interface-addressed generation', async () => {
    manifest = { status: 404, body: '' };
    entry = 'import{__vitePreload as m}from"./i18n.a56b3675.js";';
    const { code, output } = await gate();
    expect(code).toBe(1);
    expect(output).toContain('chunk names cannot be resolved');
  }, 90_000);

  it('fails when the manifest is not a manifest (an HTML error page, a wrong version)', async () => {
    entry = 'import{__vitePreload as m}from"./i18n.a56b3675.js";';
    for (const body of ['<html>Not Found</html>', JSON.stringify({ v: 2, chunks: {} }), '{"v":1,"chunks":']) {
      manifest = { status: 200, body };
      const { code, output } = await gate();
      expect(code, body).toBe(1);
      expect(output, body).toContain('chunk names cannot be resolved');
    }
  }, 120_000);

  it('fails when the manifest is valid but does not list a chunk the client reads', async () => {
    manifest = { status: 200, body: JSON.stringify({ v: 1, chunks: { routerBlogData: 'routerBlogData.12345678.js' } }) };
    const { code, output } = await gate();
    expect(code).toBe(1);
    expect(output).toContain('is not listed in the published chunk manifest');
  }, 90_000);

  it('falls back to the plain names only on a generation that predates interface-hashed names', async () => {
    manifest = { status: 404, body: '' };
    entry = 'import{__vitePreload as m}from"./i18n.js";';
    const { output } = await gate();
    // It gets past chunk resolution (the hub itself is not served here, so it stops later, for another reason).
    expect(output).not.toContain('chunk names cannot be resolved');
    expect(output).not.toContain('is not listed in the published chunk manifest');
  }, 90_000);
});
