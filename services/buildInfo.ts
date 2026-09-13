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

export function fetchCommitHash(): Promise<string> {
  return fetchTextFile('/commit-hash.txt');
}

export function fetchBuildId(): Promise<string> {
  return fetchTextFile('/build-id.txt');
}
