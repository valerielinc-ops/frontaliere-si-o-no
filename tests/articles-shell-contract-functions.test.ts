// Cross-repo guard on the FUNCTION half of SiteShellContract (issue #4974 item 3).
//
// The articles repo carries a transported copy of this contract under its
// `host/` tree so it can render without this repository. The scalar half is
// pinned by tests/articles-shell-contract-fingerprint.test.ts; this pins the
// functions, which a digest cannot cover — a SHA over their source fires on
// every comment reflow and still misses a behavioural change made through a
// dependency.
//
// Both repos run the SAME probe against the SAME golden, so either side
// drifting fails on its own side. When a change here is intentional,
// re-record with `node host/tests/shell-contract-functions.test.mjs --record`
// in the articles repo and commit the updated JSON in BOTH repos together.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

async function probe() {
  const { contract: c } = await import('../build-plugins/articlesSiteShellBootstrap');
  const out: Record<string, unknown> = {};

  out.esc = c.esc('a & b < c > d " e \' f');
  out.escEmpty = c.esc('');

  out.stripLiteralMarkdown = c.stripLiteralMarkdown('**Onkologie___Ärzte** ~~x~~ ==y==');

  out.clampMetaDescription = c.clampMetaDescription('x'.repeat(400));
  out.clampMetaDescriptionShort = c.clampMetaDescription('breve');

  out.truncateHeadline = c.truncateHeadline('Un titolo molto lungo che deve essere troncato', 20);
  out.buildTitleWithBrand = c.buildTitleWithBrand('Titolo');
  out.truncateCodeUnits = c.truncateCodeUnits('abcdefghij', 4);

  out.inlineScriptJson = c.inlineScriptJson({ a: 1, b: '</script>', c: ['x'] });

  out.railGuttersOn = c.railGutters(true);
  out.railGuttersOff = c.railGutters(false);

  out.rootShellWithBundle = c.rootShell(true);
  out.rootShellNoBundle = c.rootShell(false);

  out.asyncCssHeadBlockWith = c.asyncCssHeadBlock('main-abc123.css');
  out.asyncCssHeadBlockWithout = c.asyncCssHeadBlock(undefined);
  out.asyncCssLink = c.asyncCssLink('/assets/x.css');

  out.differentiateH1FromTitle = c.differentiateH1FromTitle('Stesso testo', 'Stesso testo', 'it');

  out.stableChunkFile = c.stableChunkFile('blog');
  out.stableChunkFiles = c.stableChunkFiles(['blog', 'jobs']);

  // WriteCollector is a constructor: pin its observable surface, not its guts.
  const wc = new c.WriteCollector({ distDir: '/tmp/nonexistent-probe', pluginName: 'probe' });
  out.writeCollectorShape = {
    hasAdd: typeof wc.add === 'function',
    hasFlush: typeof wc.flush === 'function',
    skippedByHashInitial: wc.skippedByHash,
  };

  out.imageObjectLd = c.imageObjectLd({ contentUrl: 'https://x/y.webp', caption: 'c', width: 1200 });
  out.getAuthorBySlugKnown = c.getAuthorBySlug('marco-ferrari') ?? null;
  out.getAuthorBySlugUnknown = c.getAuthorBySlug('nessuno-esiste') ?? null;

  return out;
}


describe('articles SiteShellContract — cross-repo function behaviour', () => {
  it('matches the golden the articles repo also asserts', async () => {
    const expected = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'tests/articles-shell-contract-functions.golden.json'), 'utf-8'),
    );
    const actual: Record<string, unknown> = await probe();
    for (const key of Object.keys(expected)) {
      expect(actual[key], `contract.${key} drifted — re-record in BOTH repos if intentional`)
        .toEqual(expected[key]);
    }
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  });
});
