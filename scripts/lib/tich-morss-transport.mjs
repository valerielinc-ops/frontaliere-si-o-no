import { fetchHtmlViaMorssWithRetry } from './morss-proxy.mjs';
import { isTichDetailHtmlForUrl } from './tich-detail-identity.mjs';

export { isTichDetailHtmlForUrl };

export function isTichPortalListingHtml(html = '') {
  const source = String(html || '');
  return (
    /<title[^>]*>[^<]*Amministrazione Cantonale Ticino Jobportal/i.test(source)
    && /id=["']jobslisting["']/i.test(source)
  );
}

export async function fetchTichPortalListingViaMorss(
  targetUrl,
  options = {},
) {
  const html = await fetchHtmlViaMorssWithRetry(targetUrl, options);
  return isTichPortalListingHtml(html) ? html : null;
}

export async function fetchTichDetailViaMorss(targetUrl, options = {}) {
  const html = await fetchHtmlViaMorssWithRetry(targetUrl, options);
  return isTichDetailHtmlForUrl(html, targetUrl) ? html : null;
}
