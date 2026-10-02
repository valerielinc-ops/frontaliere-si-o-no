/**
 * Affiliate revenue reconciliation — pure, network-export friendly helpers.
 *
 * The network remains the source of truth for commercial status. This module
 * only normalises an authorised export, deduplicates transaction revisions,
 * and keeps web/email exposure denominators separate. It never converts
 * currencies and never treats pending or reversed money as approved revenue.
 */

const STATUS_ALIASES = new Map([
  ['estimated', 'estimated'],
  ['pending', 'pending'],
  ['awaiting', 'pending'],
  ['approved', 'approved'],
  ['confirmed', 'approved'],
  ['paid', 'approved'],
  ['reversed', 'reversed'],
  ['declined', 'reversed'],
  ['rejected', 'reversed'],
  ['voided', 'reversed'],
]);

const STATUS_PRIORITY = { estimated: 0, pending: 1, approved: 2, reversed: 3 };
const GROUPED_THOUSANDS_RE = /^-?(?:[1-9]\d{0,2})([,.]\d{3})+$/;
const AMBIGUOUS_AMOUNT = Symbol('ambiguous amount');

const FIELD_ALIASES = {
  transactionId: ['transactionId', 'transaction_id', 'id', 'commissionId', 'commission_id'],
  network: ['network', 'program', 'source'],
  partnerId: ['partnerId', 'partner_id', 'partner', 'publisherReferencePartner'],
  surface: ['surface', 'channel'],
  status: ['status', 'commissionStatus', 'commission_status', 'state'],
  currency: ['currency', 'currencyCode', 'currency_code'],
  amount: ['amount', 'commission', 'commissionAmount', 'commission_amount', 'revenue'],
  occurredAt: ['occurredAt', 'occurred_at', 'transactionDate', 'transaction_date', 'date'],
  updatedAt: ['updatedAt', 'updated_at', 'modifiedAt', 'modified_at'],
  pubref: ['pubref', 'publisherReference', 'publisher_reference', 'subId', 'sub_id', 'attribution_id'],
};

function firstValue(row, keys) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
      return row[key];
    }
  }
  return null;
}

function asIsoDate(raw) {
  const time = Date.parse(String(raw ?? ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normaliseAmountFormat(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value || value === 'auto') return null;
  return value === 'decimal' || value === 'grouped' ? value : undefined;
}

/**
 * Parse one export amount. `asMoney()` may infer only unambiguous values;
 * callers must declare `amountFormat` for a non-zero grouped three-digit
 * value such as `12.500`, so the reconciliation never guesses a 1,000x shift.
 */
function asMoney(raw, amountFormat = null) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const compact = String(raw ?? '').replace(/[^0-9,.-]/g, '');
  if (!compact) return null;
  const comma = compact.lastIndexOf(',');
  const dot = compact.lastIndexOf('.');
  let normalized = compact;
  if (comma !== -1 && dot !== -1) {
    // The last separator is decimal; the other one is a thousands separator.
    const decimal = comma > dot ? ',' : '.';
    const thousands = decimal === ',' ? /\./g : /,/g;
    normalized = compact.replace(thousands, '').replace(decimal, '.');
  } else if (comma !== -1 || dot !== -1) {
    const separator = comma !== -1 ? ',' : '.';
    const grouped = GROUPED_THOUSANDS_RE.test(compact);
    if (grouped && amountFormat === 'grouped') {
      normalized = compact.replaceAll(separator, '');
    } else if (grouped && amountFormat === 'decimal') {
      normalized = compact.replace(separator, '.');
    } else if (grouped) {
      // 12.500 may be twelve and a half or twelve thousand five hundred.
      // Never guess a 1,000x multiplier when the export did not declare its
      // precision/separator convention.
      if (/^-?0[,.]\d{3}$/.test(compact)) normalized = compact.replace(separator, '.');
      else if ((compact.match(new RegExp(`\\${separator}`, 'g')) || []).length > 1) {
        normalized = compact.replaceAll(separator, '');
      } else {
        return AMBIGUOUS_AMOUNT;
      }
    } else {
      normalized = compact.replace(separator, '.');
    }
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function asCurrency(raw) {
  const value = String(raw ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : null;
}

function normaliseStatus(raw) {
  return STATUS_ALIASES.get(String(raw ?? '').trim().toLowerCase()) || null;
}

function normaliseId(raw) {
  const value = String(raw ?? '').trim();
  return value && value.length <= 200 ? value : null;
}

/**
 * Normalise one network row. Invalid rows are returned as a diagnostic, not
 * silently counted as zero.
 */
export function normalizeAffiliateTransaction(row, { amountFormat = null } = {}) {
  const transactionId = normaliseId(firstValue(row, FIELD_ALIASES.transactionId));
  const status = normaliseStatus(firstValue(row, FIELD_ALIASES.status));
  const currency = asCurrency(firstValue(row, FIELD_ALIASES.currency));
  const normalisedAmountFormat = normaliseAmountFormat(amountFormat);
  const amount = normalisedAmountFormat === undefined
    ? null
    : asMoney(firstValue(row, FIELD_ALIASES.amount), normalisedAmountFormat);
  const occurredAt = asIsoDate(firstValue(row, FIELD_ALIASES.occurredAt));
  const updatedAt = asIsoDate(firstValue(row, FIELD_ALIASES.updatedAt));
  const errors = [];
  if (!transactionId) errors.push('missing transaction id');
  if (!status) errors.push('unsupported status');
  if (!currency) errors.push('missing ISO-4217 currency');
  if (normalisedAmountFormat === undefined) errors.push('unsupported amount format');
  else if (amount === AMBIGUOUS_AMOUNT) errors.push('ambiguous numeric amount; specify amountFormat as decimal or grouped');
  else if (amount === null) errors.push('missing numeric amount');
  if (!occurredAt) errors.push('missing transaction date');
  if (errors.length) return { ok: false, errors, row };

  return {
    ok: true,
    value: {
      transactionId,
      network: String(firstValue(row, FIELD_ALIASES.network) || 'unknown').trim().toLowerCase(),
      partnerId: String(firstValue(row, FIELD_ALIASES.partnerId) || 'unknown').trim().toLowerCase(),
      status,
      currency,
      amount,
      occurredAt,
      updatedAt,
      pubref: String(firstValue(row, FIELD_ALIASES.pubref) || '').trim() || null,
      surface: ['web', 'email', 'newsletter'].includes(firstValue(row, FIELD_ALIASES.surface))
        ? (firstValue(row, FIELD_ALIASES.surface) === 'newsletter' ? 'email' : firstValue(row, FIELD_ALIASES.surface)) : null,
    },
  };
}

function compareRevision(a, b) {
  const aDate = Date.parse(a.updatedAt || a.occurredAt);
  const bDate = Date.parse(b.updatedAt || b.occurredAt);
  if (aDate !== bDate) return aDate - bDate;
  const statusDelta = (STATUS_PRIORITY[a.status] || 0) - (STATUS_PRIORITY[b.status] || 0);
  if (statusDelta !== 0) return statusDelta;
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

function inPeriod(iso, from, to) {
  const date = iso.slice(0, 10);
  return (!from || date >= from) && (!to || date <= to);
}

function revenueBucket() {
 return { estimated: 0, pending: 0, approved: 0, reversed: 0,
  estimatedConversions: 0, pendingConversions: 0, approvedConversions: 0, reversedConversions: 0,
  approvedBySurface: { web: 0, email: 0, unattributed: 0 },
  approvedPer1000Exposures: { web: null, email: null } };
}

function exposureCount(raw) {
 if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return null;
 const value = Number(raw);
 return Number.isFinite(value) && value >= 0 ? value : null;
}

function ratePerThousand(amount, denominator) {
  return denominator > 0 ? Number(((amount / denominator) * 1000).toFixed(4)) : null;
}

/**
 * Reconcile a network export for an inclusive UTC date period.
 *
 * `exposures.web` and `exposures.email` are deliberately independent. The
 * caller must provide the denominator; absent data stays null/unmeasurable.
 * @param {{ rows?: object[], from?: string|null, to?: string|null,
 *   exposures?: { web?: number|null, email?: number|null, byAttribution?: Record<string, number|null> }, amountFormat?: string|null }} [args]
 * @returns {object}
 */
export function reconcileAffiliateTransactions({ rows, from = null, to = null, exposures = {}, amountFormat = null } = {}) {
  const sourceRows = Array.isArray(rows) ? rows : null;
  if (!sourceRows) {
    return {
      status: 'unmeasurable',
      reason: 'affiliate export rows are missing',
      period: { from, to },
      invalidRows: 0,
      deduplicatedTransactions: 0,
      byCurrency: {},
      exposures: { web: null, email: null },
    };
  }

  const invalidRows = [];
  const revisions = new Map();
  for (const row of sourceRows) {
    const normalised = normalizeAffiliateTransaction(row, { amountFormat });
    if (!normalised.ok) {
      invalidRows.push(normalised);
      continue;
    }
    const value = normalised.value;
    if (!inPeriod(value.occurredAt, from, to)) continue;
    const key = `${value.network}:${value.transactionId}`;
    const previous = revisions.get(key);
    if (!previous || compareRevision(previous, value) < 0) revisions.set(key, value);
  }

  const byCurrency = {};
  const byAttribution = {};
  let conversions = 0;
  for (const value of revisions.values()) {
    const bucket = byCurrency[value.currency] || (byCurrency[value.currency] = revenueBucket());
    bucket[value.status] = Number((bucket[value.status] + value.amount).toFixed(2));
    bucket[`${value.status}Conversions`] += 1;
    if (value.status !== 'estimated') conversions += 1;
    if (value.status === 'approved') {
     // A GA4 placement join proves web origin; otherwise require the network's explicit channel.
     const surface = value.surface || (value.pubref && Object.hasOwn(exposures.byAttribution || {}, value.pubref) ? 'web' : 'unattributed');
     bucket.approvedBySurface[surface] = Number((bucket.approvedBySurface[surface] + value.amount).toFixed(2));
    }
    // Preserve the exact network reference. Never infer a person or an unhashed placement.
    const key = JSON.stringify([value.partnerId, value.pubref]);
    const attribution = byAttribution[key] || (byAttribution[key] = {
      partnerId: value.partnerId, attributionId: value.pubref, byCurrency: {},
    });
    const attributed = attribution.byCurrency[value.currency] || (attribution.byCurrency[value.currency] = revenueBucket());
    attributed[value.status] = Number((attributed[value.status] + value.amount).toFixed(2));
    attributed[`${value.status}Conversions`] += 1;
  }

  const webExposures = exposureCount(exposures.web);
  const emailExposures = exposureCount(exposures.email);
  for (const bucket of Object.values(byCurrency)) {
    bucket.approvedPer1000Exposures.web = bucket.approvedBySurface.unattributed ? null : ratePerThousand(bucket.approvedBySurface.web, webExposures);
    bucket.approvedPer1000Exposures.email = bucket.approvedBySurface.unattributed ? null : ratePerThousand(bucket.approvedBySurface.email, emailExposures);
  }

  for (const attribution of Object.values(byAttribution)) {
   const impressions = exposureCount(exposures.byAttribution?.[attribution.attributionId]);
   attribution.impressions = impressions;
   for (const bucket of Object.values(attribution.byCurrency)) {
    bucket.approvedPer1000Impressions = ratePerThousand(bucket.approved, impressions);
   }
  }

  const hasDenominator = webExposures !== null || emailExposures !== null;
  const allSuppliedRowsInvalid = sourceRows.length > 0
    && invalidRows.length === sourceRows.length;
  const status = allSuppliedRowsInvalid || !hasDenominator ? 'unmeasurable' : 'measurable';
  return {
    status,
    reason: allSuppliedRowsInvalid
      ? 'affiliate export rows are all invalid'
      : hasDenominator ? null : 'web/email exposure denominator is missing',
    period: { from, to },
    invalidRows: invalidRows.length,
    invalidReasons: [...new Set(invalidRows.flatMap((entry) => entry.errors))],
    deduplicatedTransactions: revisions.size,
    conversions,
    exposures: { web: webExposures, email: emailExposures },
    byCurrency,
    byAttribution: Object.values(byAttribution),
  };
}

/** Parse a small RFC-4180-compatible CSV export without adding a dependency. */
export function parseAffiliateCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < String(text).length; i += 1) {
    const char = String(text)[i];
    const next = String(text)[i + 1];
    if (char === '"' && quoted && next === '"') { cell += '"'; i += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ',' && !quoted) { row.push(cell); cell = ''; continue; }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  const [header, ...data] = rows;
  if (!header) return [];
  return data.map((values) => Object.fromEntries(header.map((key, index) => [key.trim(), values[index] ?? ''])));
}

/** Summarise a JSON/CSV export into rows plus optional exposure denominators. */
export function parseAffiliateExport(raw, { webExposures = null, emailExposures = null, amountFormat = null } = {}) {
  if (Array.isArray(raw)) return { rows: raw, exposures: { web: webExposures, email: emailExposures }, amountFormat };
  if (raw && typeof raw === 'object') {
    return {
      rows: raw.transactions || raw.rows || [],
      exposures: {
        web: raw.exposures?.web ?? webExposures,
        email: raw.exposures?.email ?? emailExposures,
        byAttribution: raw.exposures?.byAttribution,
      },
      amountFormat: raw.amountFormat ?? amountFormat,
    };
  }
  return { rows: [], exposures: { web: webExposures, email: emailExposures }, amountFormat };
}
