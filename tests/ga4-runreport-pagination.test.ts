import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { fetchGa4WebVitals, paginateGa4Report, runGa4ReportPaged } from '../scripts/lib/ga4-service-account.mjs';
import { fetchAttribution } from '../scripts/lib/cwv-attribution.mjs';
import { assertCompleteReport } from '../scripts/lib/conversion-funnel-report.mjs';

// Classe di difetto della issue 11423: un runReport GA4 chiesto con un limit
// fisso e senza offset tratta come «fonte assente» una popolazione che
// supera una pagina. paginateGa4Report legge fino a rowCount; questi test
// fissano l'arresto, i segnali di incompletezza e il consumer web-vitals.

type Row = { dimensionValues: { value: string }[]; metricValues: { value: string }[] };

function pagedData(totalRows: number, { rowCountAt = () => totalRows }: { rowCountAt?: (offset: number) => number } = {}) {
  return vi.fn(async (body: { offset?: number; limit: number }) => {
    const offset = Number(body.offset ?? 0);
    const end = Math.min(totalRows, offset + Number(body.limit));
    const rows: Row[] = [];
    for (let i = offset; i < end; i += 1) {
      rows.push({ dimensionValues: [{ value: `/p/${i}/` }], metricValues: [{ value: '1' }] });
    }
    return { rowCount: rowCountAt(offset), rows };
  });
}

describe('paginateGa4Report', () => {
  it('legge tutte le pagine fino a rowCount con offset crescenti', async () => {
    const fetchPage = pagedData(25);
    const report = await paginateGa4Report({ body: { dimensions: [] }, fetchPage, pageSize: 10 });
    expect(report.rows).toHaveLength(25);
    expect(report.complete).toBe(true);
    expect(fetchPage.mock.calls.map(([body]) => [body.offset, body.limit])).toEqual([[0, 10], [10, 10], [20, 10]]);
  });

  it('non supera il massimo di righe per richiesta dell\'API', async () => {
    const fetchPage = pagedData(3);
    await paginateGa4Report({ body: {}, fetchPage, pageSize: 1_000_000 });
    expect(fetchPage.mock.calls[0][0].limit).toBe(250_000);
  });

  it('accumula pagine da 250000 righe senza superare il limite di argomenti', async () => {
    const total = 250_001;
    const fetchPage = vi.fn(async (body: { offset: number; limit: number }) => ({
      rowCount: total,
      rows: Array.from({ length: Math.min(body.limit, total - body.offset) }, (_, i) => body.offset + i),
    }));
    const report = await paginateGa4Report({ body: {}, fetchPage, pageSize: 250_000 });
    expect(report.rows).toHaveLength(total);
    expect(report.complete).toBe(true);
  });

  it('si ferma su una pagina corta e dichiara incompleta la coda mancante', async () => {
    const fetchPage = vi.fn(async () => ({ rowCount: 50, rows: [{ dimensionValues: [], metricValues: [] }] }));
    const report = await paginateGa4Report({ body: {}, fetchPage, pageSize: 10 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(report.complete).toBe(false);
  });

  it('dichiara incompleto un report oltre il tetto di righe', async () => {
    const report = await paginateGa4Report({ body: {}, fetchPage: pagedData(30), pageSize: 10, maxRows: 20 });
    expect(report.rows).toHaveLength(20);
    expect(report.capped).toBe(true);
    expect(report.complete).toBe(false);
  });

  it('dichiara incompleto un rowCount che cambia fra le pagine', async () => {
    const report = await paginateGa4Report({
      body: {}, pageSize: 10,
      fetchPage: pagedData(20, { rowCountAt: (offset) => (offset === 0 ? 20 : 21) }),
    });
    expect(report.rowCountChanged).toBe(true);
    expect(report.complete).toBe(false);
  });

  it('senza rowCount tratta una pagina piena come possibile troncamento', async () => {
    const full = vi.fn(async (body: { limit: number }) => ({
      rows: Array.from({ length: body.limit }, () => ({ dimensionValues: [], metricValues: [] })),
    }));
    const report = await paginateGa4Report({ body: {}, fetchPage: full, pageSize: 5, maxRows: 5 });
    expect(report.complete).toBe(false);
    const empty = await paginateGa4Report({ body: {}, fetchPage: vi.fn(async () => ({})), pageSize: 5 });
    expect(empty.complete).toBe(true);
    expect(empty.rows).toEqual([]);
  });

  it('unisce i segnali metadata di ogni pagina', async () => {
    let call = 0;
    const fetchPage = vi.fn(async (body: { offset?: number; limit: number }) => {
      call += 1;
      const rows = Array.from({ length: call === 1 ? body.limit : 2 }, () => ({ dimensionValues: [], metricValues: [] }));
      return { rowCount: body.limit + 2, rows, metadata: call === 2 ? { dataLossFromOtherRow: true, timeZone: 'X' } : { timeZone: 'Europe/Zurich' } };
    });
    const report = await paginateGa4Report({ body: {}, fetchPage, pageSize: 4 });
    expect(report.complete).toBe(true);
    expect(report.metadata).toMatchObject({ dataLossFromOtherRow: true, timeZone: 'Europe/Zurich' });
  });
});

describe('fetchGa4WebVitals', () => {
  it('pagina oltre le 100000 righe invece di dichiarare troncata la distribuzione', async () => {
    const total = 150_000;
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const offset = Number(body.offset ?? 0);
      const end = Math.min(total, offset + Number(body.limit));
      const rows: Row[] = [];
      for (let i = offset; i < end; i += 1) {
        rows.push({ dimensionValues: [{ value: '/' }, { value: 'CLS' }, { value: String(i % 300) }, { value: 'mobile' }], metricValues: [{ value: '1' }] });
      }
      return { ok: true, status: 200, json: async () => ({ rowCount: total, rows }), text: async () => '' };
    });
    const observations: any = await fetchGa4WebVitals({ token: 't', startDate: '2026-09-01', endDate: '2026-09-07', fetchImpl });
    expect(observations).toHaveLength(total);
    expect(observations.coverage.truncated).toBe(false);
    expect(observations.coverage.returnedRows).toBe(observations.coverage.totalRows);
  });
});

// Fake della Data API che rispetta offset/limit (default GA4: 10000 righe).
function pagedFetch(totalFor: (body: any) => number, makeRow: (i: number, body: any) => Row) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const total = totalFor(body);
    const offset = Number(body.offset ?? 0);
    const end = Math.min(total, offset + Number(body.limit ?? 10_000));
    const rows: Row[] = [];
    for (let i = offset; i < end; i += 1) rows.push(makeRow(i, body));
    return { ok: true, status: 200, json: async () => ({ rowCount: total, rows }), text: async () => '' };
  });
}

describe('runGa4ReportPaged', () => {
  it('restituisce una risposta runReport intera con il verdetto di completezza', async () => {
    const fetchImpl = pagedFetch(() => 25, (i) => ({ dimensionValues: [{ value: `/l/${i}/` }], metricValues: [{ value: '1' }] }));
    const data = await runGa4ReportPaged({ token: 't', body: { limit: 10 }, fetchImpl });
    expect(data.rows).toHaveLength(data.rowCount);
    expect(data.complete).toBe(true);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    expect(() => assertCompleteReport(data, 10, 'landingPages')).not.toThrow();
    expect(() => assertCompleteReport({ ...data, complete: false }, 10, 'landingPages')).toThrow('incomplete');
  });
});

describe('fetchAttribution (cwv-attribution)', () => {
  it('pagina le popolazioni (a) e (c) oltre una pagina; il top-N dei selettori resta una richiesta', async () => {
    const isTemplate = (body: any) => body.dimensions.some((d: { name: string }) => d.name === 'customEvent:page_template');
    const isSelector = (body: any) => body.dimensions.some((d: { name: string }) => d.name === 'customEvent:details');
    const fetchImpl = pagedFetch(
      (body) => (isSelector(body) ? 3 : isTemplate(body) ? 120_000 : 12_000),
      (i, body) => (isTemplate(body)
        ? { dimensionValues: [{ value: 'job_detail' }, { value: 'CLS' }, { value: String(i % 400) }, { value: 'mobile' }], metricValues: [{ value: '1' }] }
        : { dimensionValues: [{ value: `/p/${i}/` }, { value: 'web_vitals' }, { value: 'cls' }, { value: 'main' }, { value: 'load' }, { value: 'x|ac1|cc1' }], metricValues: [{ value: '1' }] }),
    );
    const report = await fetchAttribution({ token: 't', startDate: '2026-09-01', endDate: '2026-09-28', fetchImpl });
    expect(report.coverage).toEqual({ attributionTruncated: false, selectorsTruncated: false, templatesTruncated: false });
    const selectorCalls = fetchImpl.mock.calls.filter(([, init]) => isSelector(JSON.parse(init.body)));
    expect(selectorCalls).toHaveLength(1);
  });
});

// Gate statico della classe: un runReport GA4 che chiede «tutte le righe»
// (limit >= 50000) in un file che non pagina e' la forma del difetto della
// issue 11423. I top-N (limit piccoli con orderBys) restano fuori per soglia.
const LARGE_LIMIT = 50_000;
const GA4_CALL_RE = /analyticsdata\.googleapis\.com|runGa4Report\(/;
const PAGED_RE = /paginateGa4Report|runGa4ReportPaged|\boffset\b/;
// `limit: N`, `limit = N` e costanti `*_LIMIT = N` (cwv-attribution TEMPLATE_LIMIT).
const LIMIT_RE = /\b(?:limit|[A-Z][A-Z_]*_LIMIT)\s*[:=]\s*([0-9][0-9_]*)/g;

function unpagedLargeLimits(source: string): number[] {
  if (!GA4_CALL_RE.test(source) || PAGED_RE.test(source)) return [];
  return [...source.matchAll(LIMIT_RE)]
    .map((m) => Number(m[1].replace(/_/g, '')))
    .filter((n) => n >= LARGE_LIMIT);
}

function scriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...scriptFiles(full));
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('gate: nessun runReport GA4 a limit grande senza paginazione', () => {
  it('riconosce la forma del difetto e lascia passare i top-N e le versioni paginate', () => {
    const before = "fetch(`https://analyticsdata.googleapis.com/v1beta/${p}:runReport`, { body: JSON.stringify({ limit: 100000 }) })";
    expect(unpagedLargeLimits(before)).toEqual([100000]);
    expect(unpagedLargeLimits('runGa4Report({ token, body: { limit: 250_000 } })')).toEqual([250000]);
    expect(unpagedLargeLimits('const TEMPLATE_LIMIT = 100000; runGa4Report({ token, body })')).toEqual([100000]);
    expect(unpagedLargeLimits('runGa4Report({ token, body: { limit: 30 } })')).toEqual([]);
    expect(unpagedLargeLimits(`${before}; paginateGa4Report({ body })`)).toEqual([]);
  });

  it('nessuno script del repo chiede tutte le righe a un runReport senza paginare', () => {
    const root = path.resolve(__dirname, '..');
    const offenders = scriptFiles(path.join(root, 'scripts'))
      .map((file) => ({ file: path.relative(root, file), limits: unpagedLargeLimits(fs.readFileSync(file, 'utf8')) }))
      .filter((entry) => entry.limits.length);
    expect(offenders).toEqual([]);
  });
});
