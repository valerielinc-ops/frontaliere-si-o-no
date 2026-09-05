import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CDN_ASSET_CHECK_MAX_URLS,
  formatCdnAssetReport,
  formatOffloadCoverageReport,
  isSoftMissing,
  verifyCdnAssetRefs,
} from '../scripts/lib/cdn-asset-existence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const res = (status: number, contentType: string | null = null) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
});

/**
 * Issue #7366 — l'offload riscrive ogni `/assets/<file>` su `${CDN_BASE}` senza
 * che nessuno verifichi che l'oggetto esista dall'altra parte. Per og/data/
 * images l'ordine del deploy rende la verifica superflua; per `/assets/` no:
 * quei riferimenti puntano al bundle dell'ULTIMO deploy, e fra essi c'e'
 * `/assets/partnerize-tag.js` — se non e' sul CDN, ogni pagina pubblicata lo
 * carica a vuoto e nessun gate diventa rosso.
 */
describe('guardia di esistenza degli /assets/ riscritti sul CDN', () => {
  it('un 404 diventa una riga ::warning::, e la verifica non lancia', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404, 'text/plain'));
    const results = await verifyCdnAssetRefs({
      urls: ['https://cdn.example.test/assets/partnerize-tag.js'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(results).toEqual([
      { url: 'https://cdn.example.test/assets/partnerize-tag.js', state: 'missing', status: 404, reason: null },
    ]);
    const report = formatCdnAssetReport(results).join('\n');
    expect(report).toContain('::warning::');
    expect(report).toContain('partnerize-tag.js');
    expect(report).toContain('1 mancanti');
  });

  it('un 200 che serve HTML al posto di uno script e MISSING, non present', async () => {
    // Il punto per cui lo status code da solo non prova niente: su questo
    // dominio un path inesistente puo' rispondere 200 + text/html (la SPA
    // servita su qualunque path). Accontentarsi di `res.ok` dichiarerebbe
    // «presente» una pagina HTML dentro un <script>.
    const fetchImpl = vi.fn().mockResolvedValue(res(200, 'text/html; charset=utf-8'));
    const [r] = await verifyCdnAssetRefs({
      urls: ['https://cdn.example.test/assets/partnerize-tag.js'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.state).toBe('missing');
    expect(r.reason).toMatch(/soft-404/);

    // Ma un .html chiesto e servito come HTML e' semplicemente presente.
    expect(isSoftMissing('https://cdn.example.test/assets/x.html', 'text/html')).toBe(false);
    // E un content-type corretto passa.
    const [ok] = await verifyCdnAssetRefs({
      urls: ['https://cdn.example.test/assets/partnerize-tag.js'],
      fetchImpl: vi.fn().mockResolvedValue(res(200, 'text/javascript')) as unknown as typeof fetch,
    });
    expect(ok.state).toBe('present');
  });

  it('rete rotta e 5xx restano UNKNOWN: fail-open, non un falso mancante', async () => {
    const [netErr] = await verifyCdnAssetRefs({
      urls: ['https://cdn.example.test/assets/a.js'],
      fetchImpl: vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as unknown as typeof fetch,
    });
    expect(netErr.state).toBe('unknown');

    const [server] = await verifyCdnAssetRefs({
      urls: ['https://cdn.example.test/assets/a.js'],
      fetchImpl: vi.fn().mockResolvedValue(res(503, 'text/html')) as unknown as typeof fetch,
    });
    expect(server.state).toBe('unknown');

    expect(formatCdnAssetReport([netErr, server]).join('\n')).not.toContain('::warning::');
  });

  it('un HEAD non implementato (405) ripiega su GET invece di contare un mancante', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(405, 'text/plain'))
      .mockResolvedValueOnce(res(200, 'text/css'));
    const [r] = await verifyCdnAssetRefs({
      urls: ['https://cdn.example.test/assets/a.css'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.state).toBe('present');
    expect(fetchImpl.mock.calls[1][1].method).toBe('GET');
  });

  it('oltre il tetto gli URL sono SKIPPED e il report lo dice: non sono «presenti»', async () => {
    const urls = Array.from({ length: CDN_ASSET_CHECK_MAX_URLS + 3 }, (_, i) => `https://cdn.example.test/assets/a${i}.js`);
    const fetchImpl = vi.fn().mockResolvedValue(res(200, 'text/javascript'));
    const results = await verifyCdnAssetRefs({ urls, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(CDN_ASSET_CHECK_MAX_URLS);
    expect(results.filter((r) => r.state === 'skipped')).toHaveLength(3);
    expect(formatCdnAssetReport(results).join('\n')).toContain('NON guardati');
  });

  it('il budget di tempo ferma la verifica anche sotto il tetto di URL', async () => {
    let clock = -100; // la prima lettura (startedAt) e' 0, poi 100, 200...
    const results = await verifyCdnAssetRefs({
      urls: ['https://cdn.example.test/assets/a.js', 'https://cdn.example.test/assets/b.js'],
      fetchImpl: vi.fn().mockResolvedValue(res(200, 'text/javascript')) as unknown as typeof fetch,
      budgetMs: 150,
      now: () => (clock += 100),
    });
    expect(results.map((r) => r.state)).toEqual(['present', 'skipped']);
  });

  it('un offload che non ha riscritto niente non si legge come «niente da riscrivere»', () => {
    // L'offload esce 0 anche quando fallisce, lasciando dist intatto: senza
    // questa discriminante il log del caso rotto e quello del caso sano sono
    // identici.
    const rotto = formatOffloadCoverageReport({ cdnRefCount: 0, sameOriginFiles: ['blog/a/index.html'] }).join('\n');
    expect(rotto).toContain('::warning::');
    expect(rotto).toContain('SAME-ORIGIN');

    const vuoto = formatOffloadCoverageReport({ cdnRefCount: 0, sameOriginFiles: [] }).join('\n');
    expect(vuoto).not.toContain('::warning::');
    expect(vuoto).toContain("non c'era niente da riscrivere");

    expect(formatOffloadCoverageReport({ cdnRefCount: 4, sameOriginFiles: [] })).toEqual([]);
  });

  it('l offload REALE raccoglie ogni URL /assets/ che ha riscritto e lo verifica', () => {
    // Cablatura end-to-end: lo script gira su un dist finto con `fetch`
    // sostituito, e si guarda cosa e' finito nel log. E' la prova che la
    // guardia sta dove passa ogni riscrittura, non su un path scelto a mano.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offload-guard-'));
    try {
      const dist = path.join(tmp, 'dist');
      fs.mkdirSync(path.join(dist, 'blog'), { recursive: true });
      fs.writeFileSync(
        path.join(dist, 'blog', 'index.html'),
        '<html><head>'
        + '<script src="/assets/partnerize-tag.js"></script>'
        + '<link rel="stylesheet" href="https://frontaliereticino.ch/assets/index-abc123.css">'
        + '</head><body>ciao</body></html>',
      );

      // `fetch` globale stubbato da un preload: lo script e' un processo a se',
      // quindi lo stub deve vivere nel SUO runtime, non in quello del test.
      const preload = path.join(tmp, 'stub-fetch.mjs');
      fs.writeFileSync(
        preload,
        'globalThis.fetch = async (url) => ({\n'
        + '  ok: String(url).includes("partnerize") ? false : true,\n'
        + '  status: String(url).includes("partnerize") ? 404 : 200,\n'
        + '  headers: { get: () => "text/css" },\n'
        + '});\n',
      );

      const out = execFileSync(
        process.execPath,
        ['--import', preload.startsWith('/') ? `file://${preload}` : preload, path.join(ROOT, 'scripts/offload-generated-images-cdn.mjs')],
        { cwd: tmp, encoding: 'utf8', env: { ...process.env, CDN_BASE: 'https://cdn.example.test' } },
      );

      // Entrambi i rami di riscrittura (relativo e assoluto) sono stati verificati.
      expect(out).toContain('2 asset CDN distinti verificati');
      // E il mancante e' un warning che nomina l'URL, non una riga muta.
      expect(out).toContain('::warning::');
      expect(out).toContain('https://cdn.example.test/assets/partnerize-tag.js');
      // La pubblicazione NON si e' rotta: lo script resta non-fatale.
      expect(fs.readFileSync(path.join(dist, 'blog', 'index.html'), 'utf8')).toContain('https://cdn.example.test/assets/partnerize-tag.js');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
