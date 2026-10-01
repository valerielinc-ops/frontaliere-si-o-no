/** AdSense unit × device report. Network metrics only: client events and
 * per-template revenue estimates must never be mixed into this population.
 * Reference: https://developers.google.com/adsense/management/reference/rest/v2/Metric */
import { isSettledDate } from './analytics-settled-window.mjs';
import { AD_SLOTS } from '../../services/adsenseSlots.ts';

export const MANUAL_SLOT_DIMENSIONS = ['AD_UNIT_ID', 'AD_UNIT_NAME', 'PLATFORM_TYPE_CODE', 'DOMAIN_NAME'];
export const MANUAL_SLOT_METRICS = ['AD_REQUESTS', 'MATCHED_AD_REQUESTS', 'IMPRESSIONS', 'ACTIVE_VIEW_MEASURABILITY', 'ACTIVE_VIEW_VIEWABILITY', 'ESTIMATED_EARNINGS'];
export const MANUAL_SLOT_SOURCE = 'Google AdSense Management API v2 accounts.reports.generate';
const METRIC_DOC = 'https://developers.google.com/adsense/management/reference/rest/v2/Metric';
const MAX_ROWS = 100_000;

function isoDate(value) {
  if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function manualSlotReportParams({ start, end, domain = 'frontaliereticino.ch' }) {
  if (!isoDate(start) || !isoDate(end) || start > end) throw new Error('Invalid AdSense report date window');
  if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error('Invalid AdSense report domain');
  const params = new URLSearchParams({ dateRange: 'CUSTOM', reportingTimeZone: 'ACCOUNT_TIME_ZONE', languageCode: 'en', limit: String(MAX_ROWS) });
  for (const [prefix, date] of [['startDate', start], ['endDate', end]]) {
    const [year, month, day] = date.split('-');
    params.set(`${prefix}.year`, year); params.set(`${prefix}.month`, String(Number(month))); params.set(`${prefix}.day`, String(Number(day)));
  }
  for (const dimension of MANUAL_SLOT_DIMENSIONS) params.append('dimensions', dimension);
  for (const metric of MANUAL_SLOT_METRICS) params.append('metrics', metric);
  params.append('filters', `DOMAIN_NAME==${domain}`);
  return params;
}
function numeric(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function slotAliases(registry) {
  const aliases = new Map();
  for (const [name, config] of Object.entries(registry)) {
    if (!config.slot) continue;
    const previous = aliases.get(config.slot) || [];
    aliases.set(config.slot, [...previous, name]);
  }
  return aliases;
}
/**
 * @param {{startDate?: {year: number, month: number, day: number}, endDate?: {year: number, month: number, day: number}, warnings?: string[], headers?: Array<{name: string, currencyCode?: string}>, currencyCode?: string, totalMatchedRows?: string | number, rows?: Array<{cells?: Array<{value?: string}>}>}} report
 * @param {{account: string, start: string, end: string, domain?: string, accountTimeZone?: string | null, registry?: Record<string, {slot: string}>, fetchedAt?: string}} options
 */
export function parseManualSlotReport(report, { account, start, end, domain = 'frontaliereticino.ch', accountTimeZone = null, registry = AD_SLOTS, fetchedAt = new Date().toISOString() }) {
  const apiDate = (date) => date ? `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}` : null;
  const actualStart = apiDate(report.startDate);
  const actualEnd = apiDate(report.endDate);
  if (actualStart !== start || actualEnd !== end) throw new Error('AdSense manual report actual date window differs from request or is missing');
  const warnings = Array.isArray(report.warnings) ? report.warnings.map(String) : [];
  const headers = report.headers || [];
  const indices = new Map(headers.map((header, index) => [header.name, index]));
  for (const name of [...MANUAL_SLOT_DIMENSIONS, ...MANUAL_SLOT_METRICS]) {
    if (!indices.has(name)) throw new Error(`AdSense manual report missing column ${name}`);
  }
  const currencyCode = headers.find((header) => header.name === 'ESTIMATED_EARNINGS')?.currencyCode || report.currencyCode || null;
  if (!currencyCode) throw new Error('AdSense manual report missing earnings currency');
  const rawRows = report.rows || [];
  const matchedRows = numeric(report.totalMatchedRows);
  if (matchedRows === null || matchedRows !== rawRows.length || rawRows.length >= MAX_ROWS) throw new Error('AdSense manual report truncated or completeness unknown');
  const aliases = slotAliases(registry);
  const rows = rawRows.map((row) => {
    const read = (name) => row.cells?.[indices.get(name)]?.value;
    if (read('DOMAIN_NAME') !== domain) throw new Error('AdSense manual report contains another domain');
    const adUnitId = String(read('AD_UNIT_ID') || '');
    const slot = adUnitId.match(/(?:^|[:/])(\d+)$/)?.[1] || adUnitId;
    const placements = aliases.get(slot) || [];
    const requests = numeric(read('AD_REQUESTS'));
    const matched = numeric(read('MATCHED_AD_REQUESTS'));
    const impressions = numeric(read('IMPRESSIONS'));
    const measurableRatio = numeric(read('ACTIVE_VIEW_MEASURABILITY'));
    const viewableRatio = numeric(read('ACTIVE_VIEW_VIEWABILITY'));
    const estimatedEarnings = numeric(read('ESTIMATED_EARNINGS'));
    for (const ratio of [measurableRatio, viewableRatio]) if (ratio !== null && (ratio < 0 || ratio > 1)) throw new Error('Invalid AdSense Active View ratio');
    return {
      adUnitId, slot, adUnitName: read('AD_UNIT_NAME') || '', device: read('PLATFORM_TYPE_CODE') || 'unknown', domain,
      placements, registeredManualUnit: placements.length > 0, sharedUnit: placements.length > 1,
      attribution: placements.length > 1 ? 'shared_ad_unit_no_page_attribution' : 'ad_unit_only_no_page_attribution',
      requests, matched, impressions, measurableRatio, viewableRatio,
      measurableCount: null, viewableCount: null,
      estimatedEarnings, currencyCode,
      coverage: requests > 0 && matched !== null ? matched / requests : null,
    };
  });
  return {
    status: warnings.length ? 'complete_with_warnings' : 'complete', warnings, source: MANUAL_SLOT_SOURCE, sourceUrl: METRIC_DOC, account, domain,
    window: { start, end, inclusive: true, settled: isSettledDate(end), reportingTimeZone: 'ACCOUNT_TIME_ZONE', accountTimeZone },
    currencyCode, fetchedAt, returnedRows: rows.length, totalMatchedRows: matchedRows,
    dimensions: MANUAL_SLOT_DIMENSIONS, metrics: MANUAL_SLOT_METRICS,
    activeViewCountAvailability: 'AdSense v2 exposes ratios, not exact measurable/viewable counts. Counts are null; no impression-based reconstruction.',
    revenueBasis: 'ESTIMATED_EARNINGS from AdSense; not finalized payment or modeled template revenue.',
    attributionLimit: 'A unit can serve several pages. Registry aliases identify reuse, not revenue by placement; no allocation to the homepage or other templates.',
    rows: rows.sort((a, b) => (b.estimatedEarnings ?? -Infinity) - (a.estimatedEarnings ?? -Infinity)),
  };
}
export async function fetchManualSlotReport({ token, account, start, end, domain = 'frontaliereticino.ch', accountTimeZone = null, fetchImpl = fetch }) {
  const params = manualSlotReportParams({ start, end, domain });
  const response = await fetchImpl(`https://adsense.googleapis.com/v2/${account}/reports:generate?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  // Do not print response bodies: token/API failures must not leak auth material.
  if (!response.ok) throw new Error(`AdSense manual slot report HTTP ${response.status}`);
  return parseManualSlotReport(await response.json(), { account, start, end, domain, accountTimeZone });
}
export function renderManualSlotReport(report) {
  if (!report || !['complete', 'complete_with_warnings'].includes(report.status)) return `AdSense unità × dispositivo: non misurabile (${report?.reason || 'report non disponibile'}).`;
  const text = (value) => String(value ?? '—').replace(/[|\r\n]/g, ' ');
  const percent = (value) => value === null ? '—' : `${(value * 100).toFixed(2)}%`;
  return [
    '## AdSense — unità × dispositivo',
    '',
    `Fonte: [AdSense API v2](${report.sourceUrl}). Dominio esatto: ${report.domain}. Finestra inclusiva: ${report.window.start} → ${report.window.end}; timezone account ${report.window.accountTimeZone || 'non restituita'}, valuta ${report.currencyCode}; ${report.window.settled ? 'finestra assestata' : 'finestra recente: elaborazione ancora possibile'}.`,
    '',
    ...(report.warnings?.length ? ['Avvisi AdSense: ' + report.warnings.map(text).join('; '), ''] : []),
    '| Slot / unità | Dispositivo | Richieste | Matched | Impressioni | Misurabilità Active View | Visibilità Active View | Ricavo stimato AdSense | Alias del registro |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|',
    ...report.rows.map((row) => `| ${text(row.slot)} / ${text(row.adUnitName)} | ${text(row.device)} | ${text(row.requests)} | ${text(row.matched)} | ${text(row.impressions)} | ${percent(row.measurableRatio)} | ${percent(row.viewableRatio)} | ${row.estimatedEarnings === null ? '—' : row.estimatedEarnings.toFixed(4)} ${text(row.currencyCode)} | ${text(row.placements.join(', ') || 'unità non mappata')} ${row.sharedUnit ? '(condivisa)' : ''} |`),
    '',
    'Le percentuali Active View sono quelle restituite da AdSense: i conteggi esatti misurabili/visibili non sono esposti da questa API e restano null nel JSON. Non sono ricostruiti moltiplicando percentuali per impressioni.',
    'Gli alias descrivono gli utilizzi possibili dello slot: non attribuiscono ricavi alla homepage né a singoli template. I ricavi sono stimati da AdSense, non pagamenti definitivi. Nessun RPM per pagina è calcolato da questi dati.',
  ].join('\n');
}
