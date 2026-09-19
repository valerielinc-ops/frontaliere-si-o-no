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
// the deployed one, i.e. /build-id.txt. Each page load fetches it at most once
// (shared with fetchBuildId); a value fetched by an earlier page of the same
// tab session serves the synchronous read meanwhile, but only while it is
// younger than BUILD_ID_SESSION_TTL_MS, so a later deploy is not mislabelled
// for long.
const BUILD_ID_SESSION_KEY = 'ft-build-id';
const BUILD_ID_SESSION_TTL_MS = 10 * 60 * 1000;
const BUILD_ID_RE = /^\d{1,20}$/;
let fetchedBuildId = '';
let buildIdFetch: Promise<string> | null = null;

function rememberBuildId(value: string): string {
  if (!BUILD_ID_RE.test(value)) return '';
  fetchedBuildId = value;
  try {
    window.sessionStorage.setItem(BUILD_ID_SESSION_KEY, `${value}@${Date.now()}`);
  } catch {
    // Private mode or blocked storage: the module value still serves this page.
  }
  return value;
}

function readSessionBuildId(): string {
  try {
    const [value = '', savedAt = ''] = (window.sessionStorage.getItem(BUILD_ID_SESSION_KEY) || '').split('@');
    const age = Date.now() - Number(savedAt);
    if (BUILD_ID_RE.test(value) && age >= 0 && age < BUILD_ID_SESSION_TTL_MS) return value;
  } catch {
    // Storage unavailable.
  }
  return '';
}

function loadBuildId(): Promise<string> {
  if (!buildIdFetch) {
    buildIdFetch = fetchTextFile('/build-id.txt').then((value) => {
      if (typeof window !== 'undefined') rememberBuildId(value);
      return value;
    });
  }
  return buildIdFetch;
}

/**
 * Build id for telemetry payloads, read synchronously: the document marker
 * when present, else the id fetched on this page, else a fresh one from an
 * earlier page of this tab session. It starts the page's single fetch.
 */
export function readBuildIdForTelemetry(): string {
  const embedded = readEmbeddedBuildId();
  if (embedded) return embedded;
  if (typeof window === 'undefined') return '';
  if (fetchedBuildId) return fetchedBuildId;
  void loadBuildId();
  return readSessionBuildId();
}

export function fetchCommitHash(): Promise<string> {
  return fetchTextFile('/commit-hash.txt');
}

export function fetchBuildId(): Promise<string> {
  return loadBuildId();
}
