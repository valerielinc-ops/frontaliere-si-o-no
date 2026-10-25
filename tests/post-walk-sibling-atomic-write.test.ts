import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeFileAtomic, writeFileAtomicSync, isSiblingSource } from '../build-plugins/shared/atomicWrite.mjs';
import { buildFlatBridgeFromSibling } from '../packages/articles/engine/flatHtmlRedirect';
import { transformHreflang } from '../build-plugins/hreflangPostprocessPlugin';
import { addIntegrityToHtml } from '../build-plugins/shared/assetIntegrity';

/**
 * Un bridge flat si deriva dal contenuto di `X/index.html`, che un altro worker
 * del post-walk puo' riscrivere nello stesso momento. Due proprieta' rendono il
 * bridge deterministico:
 *  1. il fratello viene scritto in modo atomico: un lettore vede sempre la
 *     versione intera (vecchia o nuova), mai una pagina a meta';
 *  2. nessun trasformatore del post-walk cambia `<title>` o og:*, cioe' cio' che
 *     il bridge copia: le due versioni producono lo STESSO bridge.
 */
describe('post-walk sibling writes are atomic', () => {
  it('a concurrent reader never sees a partial file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-sibling-'));
    try {
      const target = path.join(dir, 'x', 'index.html');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const a = `<html>${'A'.repeat(200_000)}</html>`;
      const b = `<html>${'B'.repeat(260_000)}</html>`;
      fs.writeFileSync(target, a);
      let stop = false;
      let torn = 0;
      let reads = 0;
      const reader = (async () => {
        while (!stop) {
          const got = fs.readFileSync(target, 'utf8');
          reads++;
          if (got !== a && got !== b) torn++;
          if (reads % 50 === 0) await new Promise((r) => setImmediate(r));
        }
      })();
      for (let i = 0; i < 120; i++) await writeFileAtomic(target, i % 2 ? a : b);
      writeFileAtomicSync(target, a);
      stop = true;
      await reader;
      expect(torn).toBe(0);
      expect(reads).toBeGreaterThan(0);
      expect(fs.readdirSync(path.dirname(target))).toEqual(['index.html']); // nessun .tmp residuo
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only index.html files are written atomically', () => {
    expect(isSiblingSource('/d/a/index.html')).toBe(true);
    expect(isSiblingSource('/d/a.html')).toBe(false);
  });
});

describe('post-walk transforms leave the bridge source (title + og:*) untouched', () => {
  const BASE = 'https://frontaliereticino.ch';
  const sibling = [
    '<!DOCTYPE html><html lang="it"><head><meta charset="utf-8">',
    '<title>Ffs Cargo, le prospettive occupazionali fanno discutere</title>',
    '<meta property="og:title" content="FFS Cargo: 80 dipendenti">',
    '<meta property="og:image" content="https://cdn.frontaliereticino.ch/images/blog/x.webp">',
    '<meta property="og:description" content="Il confronto &amp; la riorganizzazione">',
    `<link rel="alternate" hreflang="it" href="${BASE}/articoli-frontaliere/x/">`,
    `<link rel="alternate" hreflang="de" href="${BASE}/de/missing-page/">`,
    '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
    '<link rel="stylesheet" href="/assets/index-abc.css">',
    '</head><body><main><p>corpo</p></main></body></html>',
  ].join('\n');

  it('hreflang cleanup and SRI do not change what buildFlatBridgeFromSibling copies', () => {
    const slashUrl = `${BASE}/articoli-frontaliere/x/`;
    const before = buildFlatBridgeFromSibling(sibling, slashUrl);

    const exists = (abs: string) => abs.includes('articoli-frontaliere');
    const hreflang = transformHreflang(sibling, '/dist', BASE, exists, 'articoli-frontaliere/x/index.html');
    const afterHreflang = hreflang ? hreflang.html : sibling;
    const registry = new Map<string, string>([['/assets/index-abc.js', 'sha384-AAAA'], ['/assets/index-abc.css', 'sha384-BBBB']]);
    const afterSri = addIntegrityToHtml(afterHreflang, registry);

    expect(afterSri).not.toBe(sibling); // il fixture esercita davvero almeno un trasformatore
    expect(buildFlatBridgeFromSibling(afterSri, slashUrl)).toBe(before);
  });
});
