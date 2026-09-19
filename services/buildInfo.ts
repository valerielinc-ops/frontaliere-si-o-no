/**
 * Runtime fetchers for the static build-metadata files emitted by
 * build-plugins/buildIdPlugin.ts (dist/build-id.txt, dist/commit-hash.txt).
 *
 * Fetched at RUNTIME rather than baked into the JS bundle via Vite `define` —
 * baking a fresh value into the entry chunk on every build would make every
 * deploy churn ~100% of client caches for a value that's purely informational
 * (version badge, crash-report debug info).
 */

async function fetchTextFile(path: string): Promise<string> {
  try {
    const res = await fetch(path);
    if (!res.ok) return '';
    return (await res.text()).trim();
  } catch {
    return '';
  }
}

/**
 * Read metadata already present in the current document without a network
 * round-trip. This is the only reliable value for errors raised before the
 * asynchronous build-id fetch resolves.
 */
function readMeta(name: string): string {
  if (typeof document === 'undefined') return '';
  try {
    return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() || '';
  } catch {
    return '';
  }
}

export function readEmbeddedBuildId(): string {
  return readMeta('ft-build-id');
}

// Static SEO pages may ship without the marker (STATIC_BUILD_ID_META=off, see
// build-plugins/constants.ts): the per-build value made every page differ on
// every deploy. Their bundle has a stable name, so the build that matters is
// the deployed one, i.e. /build-id.txt. It is remembered per tab session so the
// synchronous telemetry read below has a value from the second event onward.
const BUILD_ID_SESSION_KEY = 'ft-build-id';
let rememberedBuildId = '';
let buildIdFetch: Promise<string> | null = null;

function rememberBuildId(value: string): string {
  if (!/^\d{1,20}$/.test(value)) return '';
  rememberedBuildId = value;
  try {
    window.sessionStorage.setItem(BUILD_ID_SESSION_KEY, value);
  } catch {
    // Private mode or blocked storage: the module value still serves this page.
  }
  return value;
}

function readRememberedBuildId(): string {
  if (rememberedBuildId) return rememberedBuildId;
  try {
    const stored = window.sessionStorage.getItem(BUILD_ID_SESSION_KEY) || '';
    if (/^\d{1,20}$/.test(stored)) rememberedBuildId = stored;
  } catch {
    // Storage unavailable.
  }
  return rememberedBuildId;
}

/**
 * Build id for telemetry payloads, read synchronously: the document marker
 * when present, otherwise the deployed build id already fetched in this tab
 * session. On a miss it starts one background fetch so later events carry it.
 */
export function readBuildIdForTelemetry(): string {
  const embedded = readEmbeddedBuildId();
  if (embedded) return embedded;
  if (typeof window === 'undefined') return '';
  const remembered = readRememberedBuildId();
  if (remembered) return remembered;
  if (!buildIdFetch) {
    buildIdFetch = fetchTextFile('/build-id.txt').then(rememberBuildId, () => '');
  }
  return '';
}

export function fetchCommitHash(): Promise<string> {
  return fetchTextFile('/commit-hash.txt');
}

export function fetchBuildId(): Promise<string> {
  return fetchTextFile('/build-id.txt').then((value) => {
    if (typeof window !== 'undefined') rememberBuildId(value);
    return value;
  });
}
