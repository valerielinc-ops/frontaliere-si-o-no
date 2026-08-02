/**
 * Coverage for the two artifacts the generator migration adds to
 * `scripts/pull-articles-api.mjs` (issue #4974 item 3; §3 and §5.5 of
 * docs/articles-generator-migration.md): the hero-image manifest and the
 * Google-News sitemap candidates nanako computes.
 *
 * These run the real script as a subprocess against a throwaway HTTP server and
 * a throwaway checkout, because the behaviour under test IS the script's exit
 * code and what it left on disk. The script is a top-level program with no
 * exported units — importing pieces of it would test a different thing than the
 * one the workflow runs.
 *
 * The posture being asserted, over and over: a missing artifact is tolerated
 * (this ships BEFORE nanako emits either), a malformed one is refused, and a
 * refusal writes NOTHING — the committed copy keeps serving.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'pull-articles-api.mjs',
);

/** A synthetic but structurally valid WebP: RIFF····WEBP + padding. */
function webp(bytes = 64): Buffer {
  const buf = Buffer.alloc(bytes);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(bytes - 8, 4);
  buf.write('WEBP', 8, 'latin1');
  return buf;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function newsUrlBlock(loc: string, publishedAt: string | null): string {
  const dateTag = publishedAt
    ? `      <news:publication_date>${publishedAt}</news:publication_date>\n`
    : '';
  return `  <url>
    <loc>${loc}</loc>
    <lastmod>${(publishedAt ?? new Date().toISOString()).slice(0, 10)}</lastmod>
    <xhtml:link rel="alternate" hreflang="it" href="${loc}" />
    <news:news>
      <news:publication>
        <news:name>Frontaliere Ticino</news:name>
        <news:language>it</news:language>
      </news:publication>
${dateTag}      <news:title>Titolo</news:title>
    </news:news>
  </url>`;
}

const urlset = (blocks: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">

${blocks.join('\n\n')}

</urlset>
`;

/** A sitemap that satisfies the pre-existing url/alternate gates. */
const blogSitemap = urlset([
  `  <url>
    <loc>https://frontaliereticino.ch/articoli-frontaliere/a/</loc>
    <xhtml:link rel="alternate" hreflang="it" href="https://frontaliereticino.ch/articoli-frontaliere/a/" />
  </url>`,
]);

const feed = `<?xml version="1.0"?><rss><channel>${'<item></item>'.repeat(12)}</channel></rss>`;

const ticker = JSON.stringify({
  articles: [
    {
      id: 'a',
      title: { it: 'T', en: 'T', de: 'T', fr: 'T' },
      slug: { it: 's', en: 's', de: 's', fr: 's' },
    },
  ],
});

const SITEMAPS = ['sitemap-blog.xml', 'sitemap-blog-ch.xml'];
const FEEDS = [
  'rss.xml',
  'rss-it.xml',
  'rss-en.xml',
  'rss-de.xml',
  'rss-fr.xml',
  'rss-svizzera.xml',
  'rss-svizzera-it.xml',
  'rss-svizzera-en.xml',
  'rss-svizzera-de.xml',
  'rss-svizzera-fr.xml',
];

/** Artifacts the server serves; a value of `undefined` is served as a 404. */
type Routes = Record<string, string | Buffer | undefined>;

let server: http.Server;
let baseUrl: string;
let routes: Routes = {};

function baseRoutes(): Routes {
  const r: Routes = {
    'manifest.json': JSON.stringify({ commit: 'deadbeefcafe', counts: { articles: 500 } }),
    'news-ticker-live.json': ticker,
  };
  for (const s of SITEMAPS) r[s] = blogSitemap;
  for (const f of FEEDS) r[f] = feed;
  return r;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').replace(/^\//, ''));
    const body = routes[name];
    if (body === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A throwaway checkout carrying the files the script expects to already serve. */
function makeCheckout(opts: { newsEntries?: string[]; windowHours?: number | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-articles-'));
  const pub = path.join(dir, 'public');
  fs.mkdirSync(pub, { recursive: true });
  // The script reads the news window out of this file rather than re-typing 48.
  // `null` models the post-cutover checkout where main no longer carries it.
  if (opts.windowHours !== null) {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'data', 'news-sitemap-whitelist.ts'),
      `export const NEWS_SITEMAP_WINDOW_HOURS = ${opts.windowHours ?? 48};\n`,
    );
  }
  for (const s of SITEMAPS) fs.writeFileSync(path.join(pub, s), blogSitemap);
  for (const f of FEEDS) fs.writeFileSync(path.join(pub, f), feed);
  fs.writeFileSync(path.join(pub, 'news-ticker-live.json'), ticker);
  fs.writeFileSync(path.join(pub, 'sitemap-news.xml'), urlset(opts.newsEntries ?? []));
  fs.writeFileSync(
    path.join(pub, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://frontaliereticino.ch/sitemap-news.xml</loc>
    <lastmod>2020-01-01</lastmod>
  </sitemap>
</sitemapindex>
`,
  );
  return dir;
}

/**
 * Deliberately async: the fixture server lives in THIS process, so a blocking
 * spawnSync would park the event loop and the child's very first fetch would
 * hang forever waiting for a server that cannot answer. That deadlock is silent
 * — it looks exactly like a slow test — so it is worth the comment.
 */
function run(cwd: string, args: string[] = []): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd,
      env: {
        ...process.env,
        ARTICLES_API_BASE: baseUrl,
        // The sandbox exports a proxy; the fixture server is loopback.
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const readPub = (dir: string, rel: string) =>
  fs.readFileSync(path.join(dir, 'public', rel), 'utf-8');

describe('pull-articles-api: hero-image manifest', () => {
  it('skips both artifacts when nanako does not publish them yet, and still pulls the rest', async () => {
    routes = baseRoutes();
    const dir = makeCheckout();

    const { code, out } = await run(dir);

    expect(code).toBe(0);
    expect(out).toContain('images-manifest.json: not published yet');
    expect(out).toContain('sitemap-news-candidates.xml: not published yet');
    // The pre-existing pulls are untouched by the new code.
    expect(out).toContain('rss.xml: 12 items');
  });

  it('fails when the artifacts are absent but --require-new is set', async () => {
    routes = baseRoutes();
    const dir = makeCheckout();

    const { code, out } = await run(dir, ['--require-new']);

    expect(code).toBe(1);
    expect(out).toContain('images-manifest.json is absent but --require-new is set');
  });

  it('downloads a listed image and writes it under public/images/blog', async () => {
    routes = {
      ...baseRoutes(),
      'images-manifest.json': JSON.stringify({
        images: [{ id: 'blog-x', path: 'images/blog/blog-x.webp', bytes: 64 }],
      }),
      'images/blog/blog-x.webp': webp(64),
    };
    const dir = makeCheckout();

    const { code } = await run(dir);

    expect(code).toBe(0);
    const written = fs.readFileSync(path.join(dir, 'public', 'images', 'blog', 'blog-x.webp'));
    expect(written.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(written).toHaveLength(64);
  });

  it('does not re-download an image it already has', async () => {
    routes = {
      ...baseRoutes(),
      'images-manifest.json': JSON.stringify({
        images: [{ id: 'blog-x', path: 'images/blog/blog-x.webp' }],
      }),
      // Deliberately NOT served: a fetch attempt would 404 and fail the run.
    };
    const dir = makeCheckout();
    const dest = path.join(dir, 'public', 'images', 'blog');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'blog-x.webp'), webp(32));

    const { code, out } = await run(dir);

    expect(code).toBe(0);
    expect(out).toContain('1 already local, 0 to fetch');
  });

  it('refuses a path that escapes public/images/blog', async () => {
    routes = {
      ...baseRoutes(),
      'images-manifest.json': JSON.stringify({
        images: [{ id: 'evil', path: '../../../../etc/passwd.webp' }],
      }),
    };
    const dir = makeCheckout();

    const { code, out } = await run(dir);

    expect(code).toBe(1);
    expect(out).toContain('is not an images/blog/<name>.webp path');
    expect(fs.existsSync(path.join(dir, 'public', 'images'))).toBe(false);
  });

  it('refuses a body that is not actually a WebP', async () => {
    routes = {
      ...baseRoutes(),
      'images-manifest.json': JSON.stringify({
        images: [{ id: 'blog-x', path: 'images/blog/blog-x.webp' }],
      }),
      'images/blog/blog-x.webp': '<html>404 from a CDN that answered 200</html>',
    };
    const dir = makeCheckout();

    const { code, out } = await run(dir);

    expect(code).toBe(1);
    expect(out).toContain('not a WebP file');
    expect(fs.existsSync(path.join(dir, 'public', 'images', 'blog', 'blog-x.webp'))).toBe(false);
  });

  it('refuses an image over the generator’s own size cap', async () => {
    routes = {
      ...baseRoutes(),
      'images-manifest.json': JSON.stringify({
        images: [{ id: 'blog-x', path: 'images/blog/blog-x.webp' }],
      }),
      'images/blog/blog-x.webp': webp(320 * 1024 + 16),
    };
    const dir = makeCheckout();

    const { code, out } = await run(dir);

    expect(code).toBe(1);
    expect(out).toContain('unoptimised file');
  });

  it('refuses when the declared byte count disagrees with what was fetched', async () => {
    routes = {
      ...baseRoutes(),
      'images-manifest.json': JSON.stringify({
        images: [{ id: 'blog-x', path: 'images/blog/blog-x.webp', bytes: 999 }],
      }),
      'images/blog/blog-x.webp': webp(64),
    };
    const dir = makeCheckout();

    const { code, out } = await run(dir);

    expect(code).toBe(1);
    expect(out).toContain('manifest says 999 bytes, fetched 64');
  });

  it('refuses an empty manifest rather than treating it as "no images"', async () => {
    routes = { ...baseRoutes(), 'images-manifest.json': JSON.stringify({ images: [] }) };
    const dir = makeCheckout();

    const { code, out } = await run(dir);

    expect(code).toBe(1);
    expect(out).toContain('lists zero images');
  });
});

describe('pull-articles-api: sitemap-news candidates', () => {
  const LOC_A = 'https://frontaliereticino.ch/articoli-frontaliere/fresh-a/';
  const LOC_B = 'https://frontaliereticino.ch/articoli-frontaliere/fresh-b/';

  it('merges candidates over what main is serving and bumps the index lastmod', async () => {
    routes = {
      ...baseRoutes(),
      'sitemap-news-candidates.xml': urlset([newsUrlBlock(LOC_B, hoursAgo(1))]),
    };
    const dir = makeCheckout({ newsEntries: [newsUrlBlock(LOC_A, hoursAgo(2))] });

    const { code } = await run(dir);

    expect(code).toBe(0);
    const news = readPub(dir, 'sitemap-news.xml');
    expect(news).toContain(LOC_A);
    expect(news).toContain(LOC_B);
    const today = new Date().toISOString().slice(0, 10);
    expect(readPub(dir, 'sitemap.xml')).toContain(`<lastmod>${today}</lastmod>`);
  });

  it('prunes an entry that has aged out of the 48h window', async () => {
    routes = {
      ...baseRoutes(),
      'sitemap-news-candidates.xml': urlset([newsUrlBlock(LOC_B, hoursAgo(1))]),
    };
    const dir = makeCheckout({ newsEntries: [newsUrlBlock(LOC_A, hoursAgo(72))] });

    const { code, out } = await run(dir);

    expect(code).toBe(0);
    const news = readPub(dir, 'sitemap-news.xml');
    expect(news).not.toContain(LOC_A);
    expect(news).toContain(LOC_B);
    expect(out).toContain('1 outside the 48h window');
  });

  it('shrinking to fewer entries is allowed — the window prune is supposed to do that', async () => {
    routes = { ...baseRoutes(), 'sitemap-news-candidates.xml': urlset([]) };
    const dir = makeCheckout({
      newsEntries: [newsUrlBlock(LOC_A, hoursAgo(80)), newsUrlBlock(LOC_B, hoursAgo(90))],
    });

    const { code } = await run(dir);

    expect(code).toBe(0);
    expect(readPub(dir, 'sitemap-news.xml')).not.toContain('<url>');
  });

  it('prunes a future publication date instead of pinning it forever', async () => {
    const future = new Date(Date.now() + 6 * 3_600_000).toISOString();
    routes = {
      ...baseRoutes(),
      'sitemap-news-candidates.xml': urlset([newsUrlBlock(LOC_B, future)]),
    };
    const dir = makeCheckout();

    const { code } = await run(dir);

    expect(code).toBe(0);
    expect(readPub(dir, 'sitemap-news.xml')).not.toContain(LOC_B);
  });

  it('takes the window from data/news-sitemap-whitelist.ts, not a hardcoded 48', async () => {
    routes = { ...baseRoutes(), 'sitemap-news-candidates.xml': urlset([]) };
    // A 6h window makes a 10h-old entry stale — under a hardcoded 48 it would survive.
    const dir = makeCheckout({ newsEntries: [newsUrlBlock(LOC_A, hoursAgo(10))], windowHours: 6 });

    const { code, out } = await run(dir);

    expect(code).toBe(0);
    expect(out).toContain('outside the 6h window');
    expect(readPub(dir, 'sitemap-news.xml')).not.toContain(LOC_A);
  });

  it('falls back to the 48h spec window when main no longer carries the whitelist', async () => {
    routes = { ...baseRoutes(), 'sitemap-news-candidates.xml': urlset([]) };
    const dir = makeCheckout({
      newsEntries: [newsUrlBlock(LOC_A, hoursAgo(10))],
      windowHours: null,
    });

    const { code, out } = await run(dir);

    expect(code).toBe(0);
    expect(out).toContain('using the 48h Google News spec window');
    // 10h old, so still inside the fallback window — it survives.
    expect(readPub(dir, 'sitemap-news.xml')).toContain(LOC_A);
  });

  it('refuses a candidate with no publication date', async () => {
    routes = {
      ...baseRoutes(),
      'sitemap-news-candidates.xml': urlset([newsUrlBlock(LOC_B, null)]),
    };
    const dir = makeCheckout();

    const { code, out } = await run(dir);

    expect(code).toBe(1);
    expect(out).toContain('has no <news:publication_date>');
  });

  it('leaves the served copy untouched when it refuses', async () => {
    routes = {
      ...baseRoutes(),
      'sitemap-news-candidates.xml': urlset([newsUrlBlock(LOC_B, null)]),
    };
    const before = urlset([newsUrlBlock(LOC_A, hoursAgo(2))]);
    const dir = makeCheckout({ newsEntries: [newsUrlBlock(LOC_A, hoursAgo(2))] });

    const { code } = await run(dir);

    expect(code).toBe(1);
    expect(readPub(dir, 'sitemap-news.xml')).toBe(before);
  });

  it('--check validates the new artifacts without writing them', async () => {
    routes = {
      ...baseRoutes(),
      'images-manifest.json': JSON.stringify({
        images: [{ id: 'blog-x', path: 'images/blog/blog-x.webp' }],
      }),
      'images/blog/blog-x.webp': webp(64),
      'sitemap-news-candidates.xml': urlset([newsUrlBlock(LOC_B, hoursAgo(1))]),
    };
    const dir = makeCheckout();

    const { code, out } = await run(dir, ['--check']);

    expect(code).toBe(0);
    expect(out).toContain('validated, wrote nothing');
    expect(readPub(dir, 'sitemap-news.xml')).not.toContain(LOC_B);
    expect(fs.existsSync(path.join(dir, 'public', 'images', 'blog', 'blog-x.webp'))).toBe(false);
  });
});
