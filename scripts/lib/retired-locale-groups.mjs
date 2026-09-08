/**
 * Persistent four-locale groups for article retirements.
 *
 * The live slug registries are pruned by the corpus sync. After that point they
 * cannot tell the edge test which localized URLs belonged to the same article,
 * so the sync records the group before deleting the row (#7669).
 */

export const RETIRED_LOCALE_GROUPS_FILE = 'data/retired-article-locale-groups.json';
export const MIN_PINNED_GROUPS = 13;

function assertPathList(key, paths, expectedLength = null) {
  if (!Array.isArray(paths) || (expectedLength !== null && paths.length !== expectedLength)) {
    throw new Error(`${RETIRED_LOCALE_GROUPS_FILE}: ${key} must contain ${expectedLength ?? 'a'} paths`);
  }
  if (paths.some((p) => typeof p !== 'string' || !p.startsWith('/'))) {
    throw new Error(`${RETIRED_LOCALE_GROUPS_FILE}: ${key} contains an invalid path`);
  }
}

export function parseRetiredLocaleGroups(text) {
  const doc = JSON.parse(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${RETIRED_LOCALE_GROUPS_FILE}: expected an object`);
  }
  if (!doc.groups || typeof doc.groups !== 'object' || Array.isArray(doc.groups)) {
    throw new Error(`${RETIRED_LOCALE_GROUPS_FILE}: expected an object under "groups"`);
  }
  const groups = new Map();
  const seen = new Set();
  for (const [key, paths] of Object.entries(doc.groups)) {
    assertPathList(key, paths, 4);
    for (const p of paths) {
      if (seen.has(p)) throw new Error(`${RETIRED_LOCALE_GROUPS_FILE}: duplicate path ${p}`);
      seen.add(p);
    }
    groups.set(key, paths);
  }
  const individualPaths = doc.ungroupedPaths ?? [];
  assertPathList('ungroupedPaths', individualPaths);
  for (const p of individualPaths) {
    if (seen.has(p)) throw new Error(`${RETIRED_LOCALE_GROUPS_FILE}: duplicate path ${p}`);
    seen.add(p);
  }
  return { groups, individualPaths };
}

export function withRemovalGroups(pinned, removals) {
  const groups = new Map(pinned.groups);
  const added = [];
  for (const removal of removals) {
    if (!removal.ledgered) continue;
    if (!removal.fullyBridged) {
      throw new Error(
        `refusing to pin ${removal.section}/${removal.id}: bridge is locale-partial `
        + `(${removal.unbridgedLocalePaths?.join(' ') ?? '?'})`,
      );
    }
    const key = `${removal.section}/${removal.id}`;
    if (groups.has(key)) continue;
    groups.set(key, [...removal.paths]);
    added.push(key);
  }
  return { groups, individualPaths: [...pinned.individualPaths], added };
}

export function serializeRetiredLocaleGroups({ groups, individualPaths }, { note } = {}) {
  const doc = {
    note:
      note
      ?? 'Four locale URLs of every retired article, preserved when the corpus registry row is pruned. '
      + 'See scripts/lib/retired-locale-groups.mjs and issue #7669.',
    groups: Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b))),
    ungroupedPaths: [...individualPaths].sort(),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
