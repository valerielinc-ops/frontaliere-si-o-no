import { matchesSumUpCheckoutReference } from '../../functions/src/sumupCheckoutReference.js';

const WINDOW_MS = 48 * 60 * 60_000;
const GRACE_MS = 15 * 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

const SOURCES = {
  assisted_applications: { date: 'updatedAt', fields: ['paymentStatus', 'paymentProvider', 'stripeSessionId', 'stripeCheckoutSessionId', 'sumupCheckoutId'] },
  application_concierge_services: { date: 'updatedAt', fields: ['paymentStatus', 'paymentProvider', 'stripeCheckoutSessionId', 'sumupCheckoutId'] },
  orders: { date: 'updatedAt', fields: ['status', 'stripeCheckoutSessionId'] },
  consulting_orders: { date: 'createdAt', fields: ['status', 'stripeSessionId'] },
  reader_checkout_claims: { date: 'claimedAt', fields: [] },
};

const json = (body, method) => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(value);

async function readCollection(firestore, collection, { date, fields }, nowMs, incomplete) {
  const start = nowMs - WINDOW_MS;
  const structuredQuery = {
    select: { fields: [date, ...fields].map((fieldPath) => ({ fieldPath })) },
    from: [{ collectionId: collection }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: date }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: new Date(start).toISOString() } } },
      { fieldFilter: { field: { fieldPath: date }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: new Date(nowMs).toISOString() } } },
    ] } },
    orderBy: [date, '__name__'].map((fieldPath) => ({ field: { fieldPath }, direction: 'DESCENDING' })),
    limit: PAGE_SIZE + 1,
  };
  const result = [];
  const seen = new Set();
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await firestore(':runQuery', json({ structuredQuery, readTime: new Date(nowMs).toISOString() }, 'POST'));
      if (rows.some((row) => !row || row.error || (!row.document && !row.readTime && row.done !== true))) {
        throw new Error('invalid_response');
      }
      const documents = rows.flatMap((row) => row.document ? [row.document] : []);
      if (documents.length > PAGE_SIZE + 1) throw new Error('invalid_response');
      for (const doc of documents.slice(0, PAGE_SIZE)) {
        const name = doc.name;
        const id = name?.split('/').at(-1);
        const time = doc.fields?.[date]?.timestampValue;
        const timestamp = Date.parse(time);
        if (!validId(id) || !name.endsWith(`/documents/${collection}/${id}`)
            || seen.has(name) || !(timestamp >= start && timestamp <= nowMs)) {
          throw new Error('invalid_document');
        }
        seen.add(name);
        const string = (field) => doc.fields?.[field]?.stringValue;
        const session = string('stripeCheckoutSessionId');
        const legacySession = string('stripeSessionId');
        const sumup = string('sumupCheckoutId');
        const provider = string('paymentProvider');
        const stripeId = session || legacySession;
        const conflict = (session && legacySession && session !== legacySession)
          || (provider != null && !['stripe', 'sumup'].includes(provider))
          || (!provider && stripeId && sumup);
        result.push({
          collection, id,
          modified: Math.max(timestamp, Date.parse(doc.updateTime) || timestamp),
          state: string(fields.includes('paymentStatus') ? 'paymentStatus' : 'status'),
          stripeId: collection === 'reader_checkout_claims' ? id
            : !conflict && provider !== 'sumup' && validId(stripeId) ? stripeId : null,
          sumupId: !conflict && provider !== 'stripe' && validId(sumup) ? sumup : null,
          // Covered by a parent service: no payment of its own at a provider.
          delegated: provider === 'parent_service' && !session && !legacySession && !sumup,
        });
      }
      if (documents.length <= PAGE_SIZE) return result;
      const last = documents[PAGE_SIZE - 1];
      structuredQuery.startAt = {
        before: false,
        values: [{ timestampValue: last.fields[date].timestampValue }, { referenceValue: last.name }],
      };
    }
    incomplete(`firestore.${collection}.page_limit`);
  } catch {
    incomplete(`firestore.${collection}.query_failed`);
    return [];
  }
  return result;
}

export async function readPaymentRecords(firestore, nowMs, incomplete) {
  return (await Promise.all(Object.entries(SOURCES).map(([collection, schema]) =>
    readCollection(firestore, collection, schema, nowMs, incomplete)))).flat();
}

function stripeCollection(row) {
  if (row.reader) return row.product === null && !row.publisher ? 'reader_checkout_claims' : null;
  if (row.product === 'assisted_application') return 'assisted_applications';
  if (row.product === 'application_concierge') return 'application_concierge_services';
  if (row.product === 'consulting') return 'consulting_orders';
  if (row.publisher) return 'orders';
  return null;
}

function matchesStripe(row, record) {
  if (stripeCollection(row) !== record.collection || row.referenceConflict) return false;
  switch (record.collection) {
    case 'consulting_orders':
      return (row.orderId ?? row.id) === record.id;
    case 'reader_checkout_claims':
      return row.id === record.id;
    case 'application_concierge_services':
      return row.serviceId === record.id;
    default:
      return row.orderId === record.id;
  }
}

function applicationState(record) {
  if (record.collection === 'reader_checkout_claims') return 'paid';
  if (record.state === 'paid' || (record.collection === 'orders' && record.state === 'active')) return 'paid';
  if (record.collection === 'orders' && record.state === 'created') return 'unpaid';
  if (record.state === 'refunded' && record.collection !== 'orders') return 'refunded';
  if (['assisted_applications', 'application_concierge_services'].includes(record.collection)
      && ['pending', 'failed', 'unpaid'].includes(record.state)) return 'unpaid';
  return 'unknown';
}

export function reconcilePayments(records, stripe, sumup, nowMs) {
  const counts = { matched: 0, providerPaidAppUnpaid: 0, appPaidProviderIncompatible: 0, grace: 0, unknown: 0, delegated: 0 };
  const stripeRows = [...(stripe?.completeCheckouts ?? []), ...(stripe?.expiredCheckouts ?? []),
    ...(stripe?.staleOpenCheckouts ?? []), ...(stripe?.lookedUpCheckouts ?? [])];
  const stripeById = new Map();
  for (const row of stripeRows) stripeById.set(row.id, stripeById.has(row.id) ? null : row);
  const sumUpById = new Map(sumup?.checkouts?.map((row) => [row.id, row]));
  const seen = new Set();

  for (const record of records) {
    if (record.delegated) {
      counts.delegated++;
      continue;
    }
    const stripeRow = stripeById.get(record.stripeId);
    const sumUpRow = sumUpById.get(record.sumupId);
    if (stripeRow && matchesStripe(stripeRow, record)) seen.add(stripeRow.id);
    if (nowMs - record.modified < GRACE_MS) {
      counts.grace++;
      continue;
    }
    let provider = 'unknown';
    if (sumUpRow && matchesSumUpCheckoutReference(sumUpRow.checkoutReference, record.id)) {
      if (sumUpRow.status === 'PAID') provider = 'paid';
      // FAILED and EXPIRED may be recovered or renewed. They are incompatible
      // with an app payment tied to this exact checkout.
      if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(sumUpRow.status)) provider = 'incompatible';
      // The payment is still being collected: consistent with an unpaid app row.
      if (['OPEN', 'PENDING'].includes(sumUpRow.status)) provider = 'pending';
    } else if (stripeRow && matchesStripe(stripeRow, record)) {
      if (stripeRow.paymentStatus === 'paid') provider = 'paid';
      if (stripeRow.status === 'expired' && stripeRow.paymentStatus === 'unpaid') provider = 'incompatible';
      if (stripeRow.status === 'open' && stripeRow.paymentStatus === 'unpaid') provider = 'pending';
    }
    const app = applicationState(record);
    if (app === 'unpaid' && provider === 'paid') counts.providerPaidAppUnpaid++;
    else if (app === 'paid' && provider === 'incompatible') counts.appPaidProviderIncompatible++;
    else if (['paid', 'refunded'].includes(app) && provider === 'paid') counts.matched++;
    else if (app === 'unpaid' && provider === 'pending') counts.matched++;
    else if (app !== 'unpaid' || provider !== 'incompatible') counts.unknown++;
  }

  // A complete session can precede its app row, belong to an older order,
  // or be a guest reader checkout that never required a claim.
  for (const row of stripeById.values()) {
    if (row && row.paymentStatus === 'paid' && stripeCollection(row) && !seen.has(row.id)) counts.unknown++;
  }
  return counts;
}

function firestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'number') return { integerValue: String(value) };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  return { mapValue: { fields: firestoreFields(value) } };
}

function firestoreFields(object) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, firestoreValue(value)]));
}

export async function writePaymentsHealth(firestore, summary) {
  await firestore(`/payments_health/${encodeURIComponent(summary.hour)}`, json({ fields: firestoreFields(summary) }, 'PATCH'));
}
