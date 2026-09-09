/**
 * Affiliate revenue reconciliation — pure, network-export friendly helpers.
 *
 * The network remains the source of truth for commercial status. This module
 * only normalises an authorised export, deduplicates transaction revisions,
 * and keeps web/email exposure denominators separate. It never converts
 * currencies and never treats pending or reversed money as approved revenue.
 */

const STATUS_ALIASES = new Map([
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

const STATUS_PRIORITY = { pending: 1, approved: 2, reversed: 3 };

const FIELD_ALIASES = {
  transactionId: ['transactionId', 'transaction_id', 'id', 'commissionId', 'commission_id'],
  network: ['network', 'program', 'source'],
  partnerId: ['partnerId', 'partner_id', 'partner', 'publisherReferencePartner'],
  status: ['status', 'commissionStatus', 'commission_status', 'state'],
  currency: ['currency', 'currencyCode', 'currency_code'],
  amount: ['amount', 'commission', 'commissionAmount', 'commission_amount', 'revenue'],
  occurredAt: ['occurredAt', 'occurred_at', 'transactionDate', 'transaction_date', 'date'],
  updatedAt: ['updatedAt', 'updated_at', 'modifiedAt', 'modified_at'],
  pubref: ['pubref', 'publisherReference', 'publisher_reference', 'subId', 'sub_id'],
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

function asMoney(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const value = Number(String(raw ?? '').replace(/[^0-9,.-]/g, '').replace(',', '.'));
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
export function normalizeAffiliateTransaction(row) {
  const transactionId = normaliseId(firstValue(row, FIELD_ALIASES.transactionId));
  const status = normaliseStatus(firstValue(row, FIELD_ALIASES.status));
  const currency = asCurrency(firstValue(row, FIELD_ALIASES.currency));
  const amount = asMoney(firstValue(row, FIELD_ALIASES.amount));
  const occurredAt = asIsoDate(firstValue(row, FIELD_ALIASES.occurredAt));
  const updatedAt = asIsoDate(firstValue(row, FIELD_ALIASES.updatedAt));
  const errors = [];
  if (!transactionId) errors.push('missing transaction id');
  if (!status) errors.push('unsupported status');
  if (!currency) errors.push('missing ISO-4217 currency');
  if (amount === null) errors.push('missing numeric amount');
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

function addMoney(bucket, currency, amount) {
  bucket[currency] = Number(((bucket[currency] || 0) + amount).toFixed(2));
}

function ratePerThousand(amount, denominator) {
  return denominator > 0 ? Number(((amount / denominator) * 1000).toFixed(4)) : null;
}

/**
 * Reconcile a network export for an inclusive UTC date period.
 *
 * `exposures.web` and `exposures.email` are deliberately independent. The
 * caller must provide the denominator; absent data stays null/unmeasurable.
 */
export function reconcileAffiliateTransactions({ rows, from = null, to = null, exposures = {} } = {}) {
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
    const normalised = normalizeAffiliateTransaction(row);
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
  let conversions = 0;
  for (const value of revisions.values()) {
    const bucket = byCurrency[value.currency] || (byCurrency[value.currency] = {
      pending: 0,
      approved: 0,
      reversed: 0,
      pendingConversions: 0,
      approvedConversions: 0,
      reversedConversions: 0,
      approvedPer1000Exposures: { web: null, email: null },
    });
    bucket[value.status] = Number((bucket[value.status] + value.amount).toFixed(2));
    bucket[`${value.status}Conversions`] += 1;
    conversions += 1;
  }

  const webExposures = Number.isFinite(Number(exposures.web)) && Number(exposures.web) >= 0
    ? Number(exposures.web)
    : null;
  const emailExposures = Number.isFinite(Number(exposures.email)) && Number(exposures.email) >= 0
    ? Number(exposures.email)
    : null;
  for (const bucket of Object.values(byCurrency)) {
    bucket.approvedPer1000Exposures.web = ratePerThousand(bucket.approved, webExposures);
    bucket.approvedPer1000Exposures.email = ratePerThousand(bucket.approved, emailExposures);
  }

  const hasDenominator = webExposures !== null || emailExposures !== null;
  return {
    status: hasDenominator ? 'measurable' : 'unmeasurable',
    reason: hasDenominator ? null : 'web/email exposure denominator is missing',
    period: { from, to },
    invalidRows: invalidRows.length,
    invalidReasons: [...new Set(invalidRows.flatMap((entry) => entry.errors))],
    deduplicatedTransactions: revisions.size,
    conversions,
    exposures: { web: webExposures, email: emailExposures },
    byCurrency,
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
export function parseAffiliateExport(raw, { webExposures = null, emailExposures = null } = {}) {
  if (Array.isArray(raw)) return { rows: raw, exposures: { web: webExposures, email: emailExposures } };
  if (raw && typeof raw === 'object') {
    return {
      rows: raw.transactions || raw.rows || [],
      exposures: {
        web: raw.exposures?.web ?? webExposures,
        email: raw.exposures?.email ?? emailExposures,
      },
    };
  }
  return { rows: [], exposures: { web: webExposures, email: emailExposures } };
}

