// Shared compact-but-line-diffable serialization for the related-search data
// files. Pretty-prints the small head (2-space) and splices the large
// collections in one item/entry per line — still valid JSON (consumers
// JSON.parse it unchanged) but without the full 2-space indentation overhead.
//
// Extracted from audit-related-search-candidates.mjs + enrich-related-search-clusters.mjs
// so the 100 MB push-limit ceiling (#1576) is enforced in ONE place. Every
// writer of `data/related-search-candidates.json` (audit AND the
// ingest-gsc-orphans augmenter) MUST go through serializeCandidatesFile — a
// second writer using plain JSON.stringify(data, null, 2) would silently revert
// the file to the un-bounded pretty format and re-inflate it ~31% toward the
// hard limit, reintroducing #1576 on an indexed dataset.

// One array element per line, 4-space item indent, 2-space closing bracket.
export function lineDelimitedArray(arr) {
  const items = Array.isArray(arr) ? arr : [];
  if (items.length === 0) return '[]';
  return `[\n${items.map((item) => `    ${JSON.stringify(item)}`).join(',\n')}\n  ]`;
}

// One key/value per line, 4-space key indent, 2-space closing brace.
export function lineDelimitedObjectMap(obj) {
  const keys = Object.keys(obj || {});
  if (keys.length === 0) return '{}';
  return `{\n${keys
    .map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(obj[k])}`)
    .join(',\n')}\n  }`;
}

// Pretty-print the small `head` object, then splice the pre-serialized large
// collections (`tail`: array of [key, serializedString] pairs) in line-delimited.
export function serializeWithLineDelimited(head, tail) {
  const headJson = JSON.stringify(head, null, 2);
  const body = headJson.slice(0, headJson.lastIndexOf('}')).replace(/\s*$/, '');
  const spliced = tail.map(([k, v]) => `  ${JSON.stringify(k)}: ${v}`).join(',\n');
  return `${body},\n${spliced}\n}\n`;
}

// Canonical serializer for data/related-search-candidates.json. Used by both the
// audit writer and the gsc-orphan ingest augmenter so the bounded format can
// never drift between the two.
export function serializeCandidatesFile(output) {
  const head = {
    generatedAt: output.generatedAt,
    sources: output.sources,
    inputs: output.inputs,
    summary: output.summary,
  };
  return serializeWithLineDelimited(head, [
    ['topNonEditorialCandidates', lineDelimitedArray(output.topNonEditorialCandidates)],
    ['candidates', lineDelimitedArray(output.candidates)],
  ]);
}
