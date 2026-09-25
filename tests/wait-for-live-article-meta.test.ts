import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = resolve(process.cwd(), 'scripts/wait-for-live-article-meta.mjs');

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map((server) =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      }),
    ),
  );
  servers.length = 0;
});

function createArticleHtml({
  baseUrl,
  title = 'Articolo di test | Frontaliere Ticino',
  ogTitle = 'Articolo di test | Frontaliere Ticino',
  ogImage = `${baseUrl}/images/blog/test.webp`,
  ogUrl = `${baseUrl}/articoli-frontaliere/test-article/`,
  canonicalUrl = '',
}: {
  baseUrl: string;
  title?: string;
  ogTitle?: string;
  ogImage?: string;
  ogUrl?: string;
  canonicalUrl?: string;
}) {
  return `<!doctype html>
<html lang="it">
  <head>
    <title>${title}</title>
    <meta property="og:title" content="${ogTitle}" />
    <meta property="og:image" content="${ogImage}" />
    ${ogUrl ? `<meta property="og:url" content="${ogUrl}" />` : ''}
    ${canonicalUrl ? `<link rel="canonical" href="${canonicalUrl}" />` : ''}
  </head>
  <body></body>
</html>`;
}

async function runWaitScript(articleUrl: string, expectedTitle = 'Articolo di test | Frontaliere Ticino', expectedImage?: string) {
  const args = [SCRIPT_PATH, articleUrl, expectedTitle];
  if (expectedImage) {
    args.push(expectedImage);
  }
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      args,
      {
        env: {
          ...process.env,
          LIVE_ARTICLE_WAIT_TIMEOUT_MS: '3000',
          LIVE_ARTICLE_WAIT_INTERVAL_MS: '50',
        },
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

function getPathname(reqUrl: string | undefined): string {
  try { return new URL(reqUrl || '/', 'http://localhost').pathname; } catch { return reqUrl || '/'; }
}

describe('wait-for-live-article-meta', () => {
  it('accepts og:url when the live page adds a trailing slash', async () => {
    const server = http.createServer((req, res) => {
      if (getPathname(req.url) === '/articoli-frontaliere/test-article') {
        const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(createArticleHtml({ baseUrl }));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });

    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const port = (server.address() as any).port;
    const articleUrl = `http://127.0.0.1:${port}/articoli-frontaliere/test-article`;
    const result = await runWaitScript(articleUrl);

    expect(result.code, result.stdout || result.stderr).toBe(0);
    expect(result.stdout).toContain('Live article metadata ready');
  });

  it('falls back to the final response URL when og:url is missing', async () => {
    const server = http.createServer((req, res) => {
      if (getPathname(req.url) === '/articoli-frontaliere/test-article') {
        const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(createArticleHtml({ baseUrl, ogUrl: '' }));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });

    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const port = (server.address() as any).port;
    const articleUrl = `http://127.0.0.1:${port}/articoli-frontaliere/test-article`;
    const result = await runWaitScript(articleUrl);

    expect(result.code, result.stdout || result.stderr).toBe(0);
    expect(result.stdout).toContain('path     = /articoli-frontaliere/test-article via final-url');
  });

  it('waits through GitHub Pages fallback responses and succeeds once article metadata is live', async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      if (getPathname(req.url) === '/articoli-frontaliere/test-article') {
        requestCount += 1;
        const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
        res.writeHead(requestCount < 3 ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
        if (requestCount < 3) {
          res.end(`<!doctype html><html><head>
            <title>Frontaliere Ticino 2026 — Calcolo Netto Nuovi e Vecchi Frontalieri</title>
            <meta property="og:title" content="Frontaliere Ticino 2026 — Calcolo Netto Nuovi e Vecchi Frontalieri" />
            <meta property="og:image" content="https://frontaliereticino.ch/og-image.png" />
            <meta property="og:url" content="https://frontaliereticino.ch/" />
          </head><body></body></html>`);
          return;
        }

        res.end(createArticleHtml({ baseUrl }));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });

    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const port = (server.address() as any).port;
    const articleUrl = `http://127.0.0.1:${port}/articoli-frontaliere/test-article`;
    const result = await runWaitScript(articleUrl);

    expect(result.code, result.stdout || result.stderr).toBe(0);
    expect(result.stdout).toContain('checks   = title:wait image:ok path:ok (final-url)');
    expect(result.stdout).toContain('Live article metadata ready');
  });

  it('normalizes HTML entities and www/apex differences when comparing OG title and image', async () => {
    const server = http.createServer((req, res) => {
      if (getPathname(req.url) === '/articoli-frontaliere/test-article') {
        const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          createArticleHtml({
            baseUrl,
            ogTitle: 'Lavoro &amp; frontalieri | Frontaliere Ticino',
            ogImage: 'https://frontaliereticino.ch/images/blog/test.webp',
          }),
        );
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });

    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const port = (server.address() as any).port;
    const articleUrl = `http://127.0.0.1:${port}/articoli-frontaliere/test-article`;
    const result = await runWaitScript(
      articleUrl,
      'Lavoro & frontalieri | Frontaliere Ticino',
      'https://frontaliereticino.ch/images/blog/test.webp',
    );

    expect(result.code, result.stdout || result.stderr).toBe(0);
    expect(result.stdout).toContain('Live article metadata ready');
  });
});
