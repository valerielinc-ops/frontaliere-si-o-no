export const LIVE_ARTICLE_META_USER_AGENT =
  'FrontaliereTicinoMetaWait/1.0 (+https://frontaliereticino.ch)';

export function normalizeArticlePageText(value) {
  return String(value || '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|rsquo|lsquo|ndash|mdash);/giu, (entity) => {
      const normalized = entity.toLowerCase();
      switch (normalized) {
        case '&amp;': return '&';
        case '&lt;': return '<';
        case '&gt;': return '>';
        case '&quot;': return '"';
        case '&apos;':
        case '&#39;': return "'";
        case '&rsquo;': return '’';
        case '&lsquo;': return '‘';
        case '&nbsp;': return ' ';
        case '&ndash;': return '–';
        case '&mdash;': return '—';
        default: return entity;
      }
    })
    .normalize('NFKC')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
