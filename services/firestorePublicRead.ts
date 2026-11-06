/**
 * Read one public Firestore document over REST, without the SDK.
 *
 * vendor-fdb-firestore.js is 598 KB decoded and 63% unused on a read-only page,
 * and it was loaded on every home and article view only to fetch one document:
 * the exchange rate, the byline override. The REST endpoint answers anonymous
 * reads under the same security rules, so a page that only reads a public
 * document does not need the client at all. Measured 2026-10-31: 200 on
 * config/exchange_rate, 404 (no override, not a denial) on
 * article_author_overrides/<id>, and CORS allows the site origin.
 *
 * Never throws: every failure means "no value", which is what each caller
 * already handles by falling back to its next source.
 */
const PROJECT_ID = import.meta.env.VITE_FIREBASE_PROJECT_ID || 'frontaliere-ticino';
const DOCUMENTS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const READ_TIMEOUT_MS = 5000;

type RestValue = {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  timestampValue?: string;
  nullValue?: null;
  mapValue?: { fields?: Record<string, RestValue> };
  arrayValue?: { values?: RestValue[] };
};

function decodeValue(value: RestValue): unknown {
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('doubleValue' in value) return value.doubleValue;
  if ('integerValue' in value) return Number(value.integerValue);
  // Milliseconds, the shape every reader normalises the SDK Timestamp into.
  if ('timestampValue' in value) return Date.parse(value.timestampValue as string);
  if ('mapValue' in value) return decodeFirestoreFields(value.mapValue?.fields);
  if ('arrayValue' in value) return (value.arrayValue?.values ?? []).map(decodeValue);
  return null;
}

export function decodeFirestoreFields(fields: Record<string, RestValue> | undefined): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields ?? {})) decoded[name] = decodeValue(value);
  return decoded;
}

/** The decoded document, or null when it is missing, denied or unreachable. */
export async function readPublicDocument(path: string): Promise<Record<string, unknown> | null> {
  try {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${DOCUMENTS_BASE}/${encodedPath}`, {
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const document = await response.json() as { fields?: Record<string, RestValue> };
    return decodeFirestoreFields(document.fields);
  } catch {
    return null;
  }
}
