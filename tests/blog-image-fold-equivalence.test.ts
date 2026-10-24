import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * La scansione blog-image condivisa col post-walk coordinator
 * (build-plugins/shared/blogImageFold.ts) deve essere ESATTAMENTE equivalente
 * allo sweep completo del finalize: stessi byte nel dist, stessi `rewritten`,
 * stessi `leaks`. Il coordinatore e' simulato qui con la sua unica
 * responsabilita' rilevante: leggere ogni file della lista HTML di lavoro e
 * riportare quelli che contengono `/images/blog/`.
 */

const ORIGIN = 'https://frontaliereticino.ch';

const FIXTURE: ReadonlyArray<readonly [string, string | Buffer]> = [
  ['index.html', `<html><img src="/images/blog/hero-a.webp"></html>`],
  ['blog/post-1/index.html', `<meta property="og:image" content="${ORIGIN}/images/blog/hero-b.png">`],
  ['blog/post-3/index.html', `<img src="/images/blog/thumbnails/x-480w.webp">`],
  [
    'blog/post-4/index.html',
    `<img src="https://cdn.frontaliereticino.ch/images/blog/f.webp">` +
      `<img src="https://raw.githubusercontent.com/o/r/main/public/images/blog/f.webp">`,
  ],
  ['sitemap-blog.xml', `<image:loc>${ORIGIN}/images/blog/hero-c.webp</image:loc>`],
  ['llms.txt', `see ${ORIGIN}/images/blog/hero-d.jpg`],
  ['cerca-lavoro-ticino/job-1/index.html', '<html>a job page, no images</html>'.repeat(50)],
  ['cerca-lavoro-ticino/job-2.html', '<!DOCTYPE html><html>flat bridge, no images</html>'],
  ['robots.txt', 'User-agent: *\nAllow: /\n'],
  ['404.html', '<html>not found</html>'],
  ['blog/post-1/data.json', `{"img":"/images/blog/hero-a.webp"}`],
  [
    'blog/post-5/index.html',
    Buffer.concat([
      Buffer.from('<html>'),
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from(`<img src="/images/blog/g.webp">`),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('</html>'),
    ]),
  ],
  ['empty.html', ''],
  ['de/index.html', `<img src="${ORIGIN}/images/blog/hero-b.png">`],
  ['de/jobs/job-1/index.html', '<html>de job</html>'],
  ['de/data/deep/index.html', `<img src="/images/blog/nested-de.webp">`],
  ['de/assets/x/page.xml', `<u>/images/blog/nested-asset.webp</u>`],
  ['en/blog/post-1/index.html', `<img src="/images/blog/hero-a.webp">`],
  ['en/data/deep/index.html', `<img src="/images/blog/nested.webp">`],
  ['fr/index.html', '<html>fr root</html>'],
  ['assets/app.html', `<img src="/images/blog/never-scanned.webp">`],
  ['data/x.html', `<img src="/images/blog/never-scanned.webp">`],
  ['images/blog/hero-a.webp', 'binary-ish'],
];

const tmpRoots: string[] = [];

function makeFixture(extra: ReadonlyArray<readonly [string, string | Buffer]> = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bifold-'));
  tmpRoots.push(root);
  const dist = path.join(root, 'dist');
  for (const [rel, content] of [...FIXTURE, ...extra]) {
    const fp = path.join(dist, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content as never);
  }
  return dist;
}

function snapshotTree(dist: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else out.set(path.relative(dist, fp).split(path.sep).join('/'), fs.readFileSync(fp).toString('base64'));
    }
  };
  walk(dist);
  return out;
}

afterEach(() => {
  for (const r of tmpRoots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  vi.resetModules();
  delete process.env.BUILD_LOCALE;
});

async function load(buildLocale: string | undefined) {
  vi.resetModules();
  if (buildLocale === undefined) delete process.env.BUILD_LOCALE;
  else process.env.BUILD_LOCALE = buildLocale;
  const fold = await import('../build-plugins/shared/blogImageFold');
  const walkMod = await import('../build-plugins/shared/distHtmlWalk');
  const plugin = await import('../build-plugins/blogImageCdnFinalizePlugin');
  const emit = await import('../build-plugins/shared/localeEmitFilter');
  return { fold, walkMod, plugin, emit };
}

/** Quello che fa il coordinatore, ridotto all'osso. */
function simulateCoordinator(
  distDir: string,
  mods: Awaited<ReturnType<typeof load>>,
  readFails: ReadonlySet<string> = new Set(),
) {
  const { fold, emit } = mods;
  const walked = fold.collectHtmlWithBlogScope(distDir);
  const markerPaths: string[] = [];
  const unscanned: string[] = [];
  const fallback: string[] = [];
  const owned = new Map<string, boolean>();
  for (const file of walked.html) {
    if (!emit.shouldEmitPath(file, distDir)) {
      if (fold.isInBlogSweepScope(distDir, file, owned)) fallback.push(file);
      continue;
    }
    if (readFails.has(file)) {
      unscanned.push(file);
      continue;
    }
    const html = fs.readFileSync(file, 'utf-8');
    if (html.includes(fold.BLOG_IMAGE_REF_MARKER)) markerPaths.push(file);
  }
  return {
    walked,
    scan: { distDir, markerPaths, extraPaths: [...walked.extras, ...fallback, ...unscanned] },
  };
}

describe.each([undefined, 'de', 'it'])('blog-image shared scan — BUILD_LOCALE=%s', (locale) => {
  it('collectHtmlWithBlogScope.html is element-for-element collectHtml', async () => {
    const mods = await load(locale);
    const dist = makeFixture();
    expect(mods.fold.collectHtmlWithBlogScope(dist).html).toEqual(mods.walkMod.collectHtml(dist, []));
  });

  it.each([1, 2, 7, 32])('parallel walk (lanes=%i) returns the same html order and extras', async (lanes) => {
    const mods = await load(locale);
    const dist = makeFixture();
    for (let d = 0; d < 40; d++) {
      for (let k = 0; k < 4; k++) {
        const dir = path.join(dist, `sec-${d % 7}`, `p-${d}`, `q-${k}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), `<p>${d}-${k}</p>`);
        if (k === 2) fs.writeFileSync(path.join(dir, 'feed.xml'), '<x/>');
        if (k === 3) { fs.mkdirSync(path.join(dir, 'data'), { recursive: true }); fs.writeFileSync(path.join(dir, 'data', 'n.html'), '<n/>'); }
      }
    }
    const sync = mods.fold.collectHtmlWithBlogScope(dist);
    const par = await mods.fold.collectHtmlWithBlogScopeParallel(dist, lanes);
    expect(par.html).toEqual(sync.html);
    expect([...par.extras].sort()).toEqual([...sync.extras].sort());
  });

  it('shared scan == full sweep: same tree, same rewritten, same leaks', async () => {
    const mods = await load(locale);
    const refDist = makeFixture();
    const newDist = makeFixture();

    const ref = await mods.plugin.sweepDistBlogImageRefs(refDist, 4);
    const { scan } = simulateCoordinator(newDist, mods);
    const got = await mods.plugin.sweepBlogImageRefsOfFiles(
      newDist,
      [...scan.markerPaths, ...scan.extraPaths],
      4,
    );

    expect(got.rewritten).toBe(ref.rewritten);
    expect(got.leaks).toEqual(ref.leaks);
    expect(snapshotTree(newDist)).toEqual(snapshotTree(refDist));
    // Il punto della ottimizzazione: rilegge meno file dello sweep completo.
    expect(got.scanned).toBeLessThanOrEqual(ref.scanned);
  });

  it('an unreadable file handed back as unscanned is still swept', async () => {
    const mods = await load(locale);
    const refDist = makeFixture();
    const newDist = makeFixture();
    const ref = await mods.plugin.sweepDistBlogImageRefs(refDist, 4);
    const { scan } = simulateCoordinator(newDist, mods, new Set([path.join(newDist, 'index.html')]));
    const got = await mods.plugin.sweepBlogImageRefsOfFiles(
      newDist,
      [...scan.markerPaths, ...scan.extraPaths],
      4,
    );
    expect(got.rewritten).toBe(ref.rewritten);
    expect(snapshotTree(newDist)).toEqual(snapshotTree(refDist));
  });

  it('a surviving leak is reported exactly as the full sweep reports it', async () => {
    const mods = await load(locale);
    // Un riferimento che le regex di rewrite non toccano ma il guard si':
    // percorso relativo preceduto da un carattere non-word dentro un attributo.
    const extra: Array<readonly [string, string]> = [
      ['blog/post-9/index.html', `<a href='/images/blog/z.webp'>x</a><img src="/images/blog/y.webp">`],
    ];
    const refDist = makeFixture(extra);
    const newDist = makeFixture(extra);
    const ref = await mods.plugin.sweepDistBlogImageRefs(refDist, 4);
    const { scan } = simulateCoordinator(newDist, mods);
    const got = await mods.plugin.sweepBlogImageRefsOfFiles(
      newDist,
      [...scan.markerPaths, ...scan.extraPaths],
      4,
    );
    expect(got.leaks).toEqual(ref.leaks);
    expect(snapshotTree(newDist)).toEqual(snapshotTree(refDist));
  });
});

describe('blog-image shared scan — handoff', () => {
  it('is consumed once and only for the matching dist', async () => {
    const { fold } = await load(undefined);
    fold.publishPostWalkBlogScan({ distDir: '/tmp/a/dist', markerPaths: ['x'], extraPaths: [] });
    expect(fold.takePostWalkBlogScan('/tmp/other/dist')).toBeNull();
    fold.publishPostWalkBlogScan({ distDir: '/tmp/a/dist', markerPaths: ['x'], extraPaths: [] });
    expect(fold.takePostWalkBlogScan('/tmp/a/dist')?.markerPaths).toEqual(['x']);
    expect(fold.takePostWalkBlogScan('/tmp/a/dist')).toBeNull();
    fold.publishPostWalkBlogScan({ distDir: '/tmp/a/dist', markerPaths: [], extraPaths: [] });
    fold.resetPostWalkBlogScan();
    expect(fold.takePostWalkBlogScan('/tmp/a/dist')).toBeNull();
  });

  it('the flag defaults off', async () => {
    const { fold } = await load(undefined);
    delete process.env.BLOG_IMAGE_CDN_FOLD;
    expect(fold.blogImageFoldEnabled()).toBe(false);
    process.env.BLOG_IMAGE_CDN_FOLD = '1';
    expect(fold.blogImageFoldEnabled()).toBe(true);
    delete process.env.BLOG_IMAGE_CDN_FOLD;
  });
});
