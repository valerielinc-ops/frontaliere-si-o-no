/**
 * Build Company Page article commentary. When Codex copy is active, its CTA
 * carries the tagged destination so the post asks for one action only.
 */
export function buildLinkedInCompanyCommentary({ emoji, title, description, socialCopy, url, hashtags } = {}) {
  const generatedCopy = socialCopy?.copyMode === 'codex' ? socialCopy : null;
  return [
    ...(generatedCopy ? [generatedCopy.hook, ''] : []),
    `${emoji || '📰'} ${String(title || '')}`,
    '',
    String(description || ''),
    '',
    generatedCopy
      ? `👉 ${generatedCopy.cta}: ${String(url || '')}`
      : `👉 Leggi l'articolo completo: ${String(url || '')}`,
    '',
    String(hashtags || ''),
  ].join('\n').trim();
}
