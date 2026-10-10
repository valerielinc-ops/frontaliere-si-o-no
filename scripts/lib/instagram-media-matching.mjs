/**
 * Conservative attribution of confirmed Instagram ledger groups to Graph API
 * media. Insights and the community worker must never disagree about which
 * post a timestamp belongs to: a missing or ambiguous match is safer than a
 * reply or metric attached to the wrong creative.
 */

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  const result = String(value ?? '').trim();
  return result || null;
}

function timestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function mediaTimestamp(media) {
  return timestamp(media?.timestamp || media?.created_time);
}

/**
 * Match ledger groups to recent Graph API media. Ties and reused candidates
 * are rejected instead of guessed. Callers may provide a surface-specific
 * missing-id reason while sharing the same matching rules.
 */
export function matchInstagramMedia(
  groups,
  media,
  {
    maxDistanceMinutes = 45,
    missingMediaIdReason = 'ledger-media-id-not-returned',
  } = {},
) {
  const safeGroups = Array.isArray(groups) ? groups.filter(isRecord) : [];
  const safeMedia = Array.isArray(media) ? media.filter(isRecord) : [];
  const byId = new Map(safeMedia.map((item) => [text(item.id), item]).filter(([mediaId]) => mediaId));
  const used = new Set();
  const matches = [];
  const unmatched = [];
  const unresolved = [];
  const maxDistanceMs = Math.max(1, Number(maxDistanceMinutes) || 45) * 60_000;

  for (const group of safeGroups) {
    const groupMediaId = text(group.mediaId);
    if (groupMediaId) {
      const item = byId.get(groupMediaId);
      if (!item || used.has(groupMediaId)) unmatched.push({ group, reason: missingMediaIdReason });
      else {
        used.add(groupMediaId);
        matches.push({ group, media: item, method: 'ledger-media-id' });
      }
      continue;
    }

    const groupTimestamp = timestamp(group.publishedAtMs);
    const candidates = safeMedia
      .map((item) => ({ item, id: text(item.id), at: mediaTimestamp(item) }))
      .filter((candidate) => candidate.id && candidate.at !== null && groupTimestamp !== null && !used.has(candidate.id))
      .map((candidate) => ({ ...candidate, distanceMs: Math.abs(candidate.at - groupTimestamp) }))
      .filter((candidate) => candidate.distanceMs <= maxDistanceMs)
      .sort((a, b) => a.distanceMs - b.distanceMs || a.id.localeCompare(b.id));
    if (candidates.length === 0) unmatched.push({ group, reason: 'media-timestamp-not-found' });
    else unresolved.push({ group, candidates });
  }

  const claims = new Map();
  for (const candidate of unresolved) {
    const best = candidate.candidates[0];
    const second = candidate.candidates[1];
    if (second && second.distanceMs - best.distanceMs <= 60_000) {
      unmatched.push({ group: candidate.group, reason: 'ambiguous-media-timestamp' });
      continue;
    }
    const claim = claims.get(best.id) || [];
    claim.push({ ...candidate, best });
    claims.set(best.id, claim);
  }
  for (const claim of claims.values()) {
    if (claim.length !== 1) {
      for (const item of claim) unmatched.push({ group: item.group, reason: 'media-candidate-reused' });
      continue;
    }
    const item = claim[0];
    used.add(item.best.id);
    matches.push({ group: item.group, media: item.best.item, method: 'confirmation-timestamp' });
  }
  return { matches, unmatched };
}
