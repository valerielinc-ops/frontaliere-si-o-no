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

function createArticleHtml(baseUrl: string) {
  return `<!doctype html>
<html lang="it">
  <head>
    <title>Articolo di test | Frontaliere Ticino</title>
    <meta property="og:title" content="Articolo di test | Frontaliere Ticino" />
    <meta property="og:image" content="${baseUrl}/images/blog/test.jpg" />
    <meta property="og:url" content="${baseUrl}/articoli-frontaliere/test-article/" />
  </head>
  <body></body>
</html>`;
}

async function runWaitScript(articleUrl: string) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [SCRIPT_PATH, articleUrl, 'Articolo di test | Frontaliere Ticino'],
      {
        env: {
          ...process.env,
          LIVE_ARTICLE_WAIT_TIMEOUT_MS: '250',
          LIVE_ARTICLE_WAIT_INTERVAL_MS: '25',
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

describe('wait-for-live-article-meta', () => {
  it('accepts og:url when the live page adds a trailing slash', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/articoli-frontaliere/test-article') {
        const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(createArticleHtml(baseUrl));
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
});
