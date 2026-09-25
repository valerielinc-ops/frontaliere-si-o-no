/**
 * Sanitize generated article body text before it is serialized into source.
 *
 * Body content is markdown, so unmatched braces are always corruption. Keep
 * balanced pairs for legitimate anchors/placeholders, drop stray closes, and
 * remove unmatched opens from the output. The same guard is used by article
 * generation and the retroactive repair path.
 */
export function sanitizeBodyText(s, log = (message) => console.error(message)) {
  if (typeof s !== 'string' || s.length === 0) return s;
  const out = [];
  let depth = 0;
  let droppedCount = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      depth++;
      out.push(ch);
    } else if (ch === '}') {
      if (depth === 0) {
        droppedCount++;
        continue;
      }
      depth--;
      out.push(ch);
    } else {
      out.push(ch);
    }
  }
  if (depth > 0) {
    let i = out.length - 1;
    let toStrip = depth;
    while (i >= 0 && toStrip > 0) {
      if (out[i] === '{') {
        out[i] = '';
        toStrip--;
      }
      i--;
    }
    droppedCount += depth;
  }
  if (droppedCount > 0) {
    log(`    ⚠️  sanitizeBodyText: removed ${droppedCount} stray brace char(s)`);
  }
  return out.join('');
}
