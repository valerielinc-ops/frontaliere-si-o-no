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

export function fetchCommitHash(): Promise<string> {
  return fetchTextFile('/commit-hash.txt');
}

export function fetchBuildId(): Promise<string> {
  return fetchTextFile('/build-id.txt');
}
