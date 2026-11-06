/**
 * `paths.some((p) => p.startsWith(prefix))` in O(1) per path quando ogni
 * prefisso e' fatto di uno o due segmenti con slash finale (`/a/`, `/en/b/`).
 * Altrimenti (forma diversa) ricade sul confronto lineare, quindi il verdetto
 * e' identico per qualunque insieme di prefissi.
 */
export function makeStartsWithAnyPrefix(prefixes: readonly string[]): (value: string) => boolean {
  const set = new Set(prefixes);
  const shallow = prefixes.every((prefix) => /^\/[^/]+\/(?:[^/]+\/)?$/.test(prefix));
  const linear = (value: string): boolean => prefixes.some((prefix) => value.startsWith(prefix));
  if (!shallow) return linear;
  return (value: string): boolean => {
    if (!value.startsWith('/')) return linear(value);
    const first = value.indexOf('/', 1);
    if (first < 0) return false;
    if (set.has(value.slice(0, first + 1))) return true;
    const second = value.indexOf('/', first + 1);
    return second >= 0 && set.has(value.slice(0, second + 1));
  };
}
