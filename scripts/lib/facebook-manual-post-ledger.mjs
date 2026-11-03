import path from 'node:path';

import { appendLedger } from './social-post-utils.mjs';

export const FACEBOOK_ARTICLE_LEDGER_RELATIVE_PATH = 'data/fb-posted-articles.json';

/** Append one confirmed manual Page post to the canonical article ledger. */
export function recordManualFacebookArticlePost({
  repoRoot,
  articleId,
  url,
  postId,
  publishedAt = new Date(),
} = {}) {
  const id = String(articleId || '').trim();
  const link = String(url || '').trim();
  const nativeId = String(postId || '').trim();
  const date = publishedAt instanceof Date ? publishedAt : new Date(publishedAt);
  if (!id || id.length > 256 || /[\r\n\u0000]/u.test(id)) throw new Error('Facebook article id is required');
  if (!link || !/^https:\/\//iu.test(link)) throw new Error('Facebook article URL must be an absolute HTTPS URL');
  if (!nativeId || nativeId.length > 256 || /[\r\n\u0000]/u.test(nativeId)) throw new Error('Facebook native post id is required');
  if (!Number.isFinite(date.getTime())) throw new Error('Facebook publish time is invalid');

  const ledgerPath = path.resolve(repoRoot || process.cwd(), FACEBOOK_ARTICLE_LEDGER_RELATIVE_PATH);
  appendLedger(ledgerPath, [{
    id,
    url: link,
    ts: date.toISOString(),
    fbPostId: nativeId,
    via: 'manual-cli',
  }]);
}
