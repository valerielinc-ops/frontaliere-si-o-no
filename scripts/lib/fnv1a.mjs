/**
 * FNV-1a, 32-bit — the ONE place this algorithm lives (AGENTS.md #6: a regex/
 * algorithm duplicated literally in ≥2 files must be extracted into a shared
 * module instead of copy-paste, so drift is impossible by construction).
 *
 * Before this module existed, the exact same 32-bit FNV-1a core (init
 * 0x811c9dc5, XOR each char code, `Math.imul(h, 0x01000193)`, `h >>> 0`) was
 * copy-pasted in three script-side files:
 *  - scripts/lib/compat-paths-store.mjs (`compatShardIndex` — deterministic
 *    404-compat-path → shard assignment; SEO-CRITICAL, see that file's
 *    docblock — changing the algorithm redistributes every path)
 *  - scripts/lib/send-schedule.mjs (`fnv1aHash` — deterministic per-email
 *    minute jitter for scheduled sends, feature #3798)
 *  - scripts/lib/topic-sources/gscOrphans.mjs (`fnv1a8` — same 32-bit core,
 *    hex-encoded for a candidate id)
 * All three now call into `fnv1a32`/`fnv1a32Mod` here instead.
 *
 * NOT consolidated: `scripts/lib/ai-models.mjs`'s `_fnv1aHex` is a genuinely
 * DIFFERENT algorithm (shift-based multiply instead of `Math.imul`, no
 * per-iteration `>>> 0`, raw un-padded hex output) and is deliberately kept
 * import-free because it's loaded in Firebase Functions contexts — see the
 * comment above `_fnv1aHex` there. It is NOT a duplicate of this module.
 */

/** FNV-1a, 32-bit, returned as an unsigned integer (`h >>> 0`). */
export function fnv1a32(str) {
  const s = String(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Convenience: `fnv1a32(str) % count` — deterministic bucket/jitter index. */
export function fnv1a32Mod(str, count) {
  return fnv1a32(str) % count;
}
