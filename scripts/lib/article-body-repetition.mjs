// ── Repetition detection + cleanup for AI-generated article bodies ──────
// Shared between scripts/create-article.mjs (preventive checks during
// generation) and scripts/repair-repetitive-articles.mjs (retroactive CLI
// repair of already-published articles). Extracted 2026-07-21 after a PR
// review caught the two implementations drifting: create-article.mjs's
// dedupeRepeatedParagraphs only stripped whole-paragraph exact duplicates,
// silently no-op-ing when detectBodyRepetition fired on its OTHER branch
// (a sentence repeated 4+ times embedded across otherwise-different
// paragraphs — no single paragraph is an exact duplicate, so paragraph-only
// dedup can't touch it). repair-repetitive-articles.mjs already had the
// correct cross-paragraph sentence-strip (deduplicateBodies); this module
// is that logic promoted to a single shared source so both call sites stay
// in sync by construction (AGENTS.md #6).
//
// Live incident this closes: articoli-svizzera swatch-crescita-2026 /
// novartis-superaspettative (2026-07-21) — a sentence repeated ~26 times
// and a 2-paragraph block copy-pasted 5x, both from
// scripts/create-article.mjs's expandShortItalianContent last-resort path,
// which had no repetition check of any kind before this fix.

const BODY_FIELDS = ['body1', 'body2', 'body3'];

/** Detect exact-duplicate paragraphs, or sentences repeated 4+ times (even across otherwise-distinct paragraphs), across body1-3. */
export function detectBodyRepetition(bodies) {
  const allBodies = BODY_FIELDS.map((k) => bodies?.[k] || '');

  // 1. Repeated paragraphs within a single body field.
  for (const [idx, body] of allBodies.entries()) {
    const paragraphs = body.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length > 60);
    const seen = new Map();
    let dupeCount = 0;
    for (const p of paragraphs) {
      const normalized = p.replace(/[.!?,;:\s]+$/g, '').toLowerCase().replace(/\s+/g, ' ');
      seen.set(normalized, (seen.get(normalized) || 0) + 1);
      if (seen.get(normalized) > 1) dupeCount++;
    }
    if (dupeCount >= 3) {
      return { hasRepetition: true, reason: `body${idx + 1} ha ${dupeCount} paragrafi ripetuti` };
    }
  }

  // 2. Sentences repeated 4+ times across all bodies — catches a repeated
  // sentence embedded inside otherwise-distinct paragraphs, which branch 1
  // (whole-paragraph comparison) cannot see.
  const allText = allBodies.join('\n\n');
  const sentences = allText.split(/[.!?]\s+/).map((s) => s.trim().toLowerCase().replace(/\s+/g, ' ')).filter((s) => s.length > 40);
  const sentCounts = new Map();
  for (const s of sentences) sentCounts.set(s, (sentCounts.get(s) || 0) + 1);
  const heavyRepeats = [...sentCounts.entries()].filter(([, c]) => c >= 4);
  if (heavyRepeats.length > 0) {
    return {
      hasRepetition: true,
      reason: `${heavyRepeats.length} frasi ripetute 4+ volte: "${heavyRepeats[0][0].substring(0, 60)}..." (${heavyRepeats[0][1]}x)`,
    };
  }

  return { hasRepetition: false, reason: '' };
}

/**
 * Strip repeated content from body1-3: exact-duplicate whole paragraphs
 * first, then sentences repeated 3+ times globally (kept only on their
 * first occurrence across the whole document) — covers both branches of
 * detectBodyRepetition, unlike a paragraph-only pass. Mutates `bodies` in
 * place AND returns it, so callers can either rely on the mutation or use
 * the return value functionally (pass a shallow copy to avoid mutating the
 * original, as scripts/repair-repetitive-articles.mjs does).
 */
export function dedupeRepeatedParagraphs(bodies) {
  // Cross-body sentence frequency, computed BEFORE any field is mutated so
  // counts reflect the original content across all three fields.
  const globalSentCounts = new Map();
  for (const field of BODY_FIELDS) {
    const text = bodies?.[field] || '';
    const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim().toLowerCase().replace(/\s+/g, ' ')).filter((s) => s.length > 30);
    for (const s of sentences) globalSentCounts.set(s, (globalSentCounts.get(s) || 0) + 1);
  }

  const globalSeen = new Map(); // cross-body: track how many times each heavily-repeated sentence has been kept so far

  for (const field of BODY_FIELDS) {
    if (!bodies?.[field]) continue;

    // Step 1: deduplicate whole paragraphs (exact match after normalization).
    const paragraphs = bodies[field].split(/\n\n+/);
    const seenParas = new Set();
    const uniqueParas = [];
    for (const p of paragraphs) {
      const norm = p.trim().replace(/[.!?,;:\s]+$/g, '').toLowerCase().replace(/\s+/g, ' ');
      if (norm.length < 60 || !seenParas.has(norm)) {
        seenParas.add(norm);
        uniqueParas.push(p);
      }
    }

    // Step 2: within each surviving paragraph, strip sentences repeated 4+
    // times globally (same bar as detectBodyRepetition's own trigger, so
    // dedup never touches a sentence that wouldn't independently have
    // flagged detection — was 3+ before code review found it could
    // silently strip unrelated, legitimately 3x-repeated content whenever
    // dedup ran for a different reason) down to a single occurrence across
    // the whole document.
    //
    // No `sentences.length < 2` short-circuit for single-sentence
    // paragraphs (code review found this too): a repeated sentence that
    // stands alone as its own paragraph — a callout/pull-quote line, which
    // this article format explicitly supports (📊/💡/⚠️ markers) — must
    // still go through the SAME filter so it both (a) gets stripped when
    // it's a repeat and (b) registers in `globalSeen` on its first/kept
    // occurrence; skipping it silently undercounted, letting one extra
    // occurrence elsewhere survive.
    const cleaned = uniqueParas
      .map((para) => {
        const sentences = para.split(/(?<=[.!?])\s+/);
        const filtered = sentences.filter((s) => {
          const norm = s.trim().toLowerCase().replace(/\s+/g, ' ');
          if (norm.length <= 30) return true;
          const globalCount = globalSentCounts.get(norm) || 1;
          if (globalCount < 4) return true;
          const soFar = (globalSeen.get(norm) || 0) + 1;
          globalSeen.set(norm, soFar);
          return soFar <= 1;
        });
        return filtered.join(' ');
      })
      .filter((p) => p.trim().length > 10);

    bodies[field] = cleaned.join('\n\n');
  }

  return bodies;
}

/** Strip the article title when echoed as the opening line of 2+ body fields. Mutates itContent. */
export function stripDuplicateTitleFromBody(itContent) {
  const titleCheck = String(itContent?.title || '').trim();
  if (!titleCheck) return;
  const allBodies = BODY_FIELDS.map((k) => itContent?.[k] || '');
  let titleInBodyCount = 0;
  for (const body of allBodies) {
    const firstLine = body.split('\n')[0].trim();
    if (firstLine === titleCheck || firstLine.startsWith(titleCheck)) titleInBodyCount++;
  }
  if (titleInBodyCount < 2) return;
  for (const field of BODY_FIELDS) {
    if (!itContent?.[field]) continue;
    const lines = itContent[field].split('\n');
    if (lines[0].trim() === titleCheck || lines[0].trim().startsWith(titleCheck)) {
      lines.shift();
      while (lines.length > 0 && lines[0].trim() === '') lines.shift();
      itContent[field] = lines.join('\n');
      console.error(`  🧹 Rimosso titolo duplicato da it.${field}`);
    }
  }
}
