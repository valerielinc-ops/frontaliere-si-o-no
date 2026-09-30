/**
 * career-ops liveness gate, run before drafting and again right before
 * submitting: is the posting still open?
 *   - our dataset: the published job-detail file is gone (404) when the
 *     crawlers stopped seeing the job;
 *   - the employer page: fetched with the same SSRF guards as the posting
 *     fallback, then classified by liveness.mjs.
 */

import { JOB_DETAIL_BASE, fetchPublicPage, htmlToText } from '../../../functions/src/assistedApplicationAiJob.js';
import { applyControlsFromHtml, classifyLiveness, isHardClosed } from './liveness.mjs';

const TIMEOUT_MS = 12_000;
const MAX_HTML = 1_500_000;

async function datasetGone(jobId, fetchImpl) {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(String(jobId || ''))) return false;
  try {
    const response = await fetchImpl(`${JOB_DETAIL_BASE}/${encodeURIComponent(jobId)}.json`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.status === 404 || response.status === 410;
  } catch {
    return false;
  }
}

export async function checkPostingLiveness({ order, posting, fetchImpl = fetch, resolve }) {
  const gone = await datasetGone(order?.jobId, fetchImpl);
  const url = posting?.applyUrl && !/^mailto:/i.test(posting.applyUrl) ? posting.applyUrl : order?.jobUrl;
  let page = { result: 'uncertain', code: 'not_checked', reason: 'no public url' };
  if (url) {
    try {
      const response = await fetchPublicPage(fetchImpl, url, resolve);
      if (response) {
        const html = (await response.text()).slice(0, MAX_HTML);
        page = classifyLiveness({
          status: response.status,
          requestedUrl: url,
          finalUrl: response.url || url,
          bodyText: htmlToText(html),
          applyControls: applyControlsFromHtml(html),
        });
      } else {
        page = { result: 'uncertain', code: 'not_public', reason: 'url not fetchable' };
      }
    } catch (error) {
      page = { result: 'uncertain', code: 'fetch_failed', reason: error instanceof Error ? error.message.slice(0, 80) : 'fetch failed' };
    }
  }
  return { page, datasetGone: gone, closed: isHardClosed(page, { datasetGone: gone }) };
}
