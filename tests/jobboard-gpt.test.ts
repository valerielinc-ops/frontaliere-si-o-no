// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/cerca-lavoro-ticino/" }

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GPT_BOOTSTRAP_TAG,
  GPT_LOADER_CONTENT,
  GPT_SCRIPT_SRC,
  isJobBoardPageUrl,
} from '@/build-plugins/jobBoardGpt';
import {
  ADS_CONSENT_CHANGE_EVENT,
  ADS_CONSENT_GRANTED,
  ADS_CONSENT_STORAGE_KEY,
} from '@/services/adsConsent';

const GPT_SELECTOR = `script[src="${GPT_SCRIPT_SRC}"]`;

describe('job-board GPT bootstrap', () => {
  beforeEach(() => {
    localStorage.clear();
    document.head.querySelectorAll('script').forEach((script) => script.remove());
    delete (window as unknown as { googletag?: unknown }).googletag;
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('recognises every localized job-board section, including deep pages', () => {
    const jobBoardUrls = [
      '/cerca-lavoro-ticino/',
      '/cerca-lavoro-zurigo/azienda-example/',
      '/en/find-jobs-zurich/all/',
      '/de/jobs-im-ticino/pflegepersonal/',
      '/de/jobs-in-der-waadt/lausanne/',
      '/fr/trouver-emploi-suisse/tous/',
      'https://frontaliereticino.ch/cerca-lavoro-ticino/job?fc=alwaysshow',
    ];
    for (const url of jobBoardUrls) expect(isJobBoardPageUrl(url)).toBe(true);

    expect(isJobBoardPageUrl('/')).toBe(false);
    expect(isJobBoardPageUrl('/articoli-frontaliere/')).toBe(false);
    expect(isJobBoardPageUrl('/en/find-jobs/')).toBe(false);
  });

  it('loads GPT only after the explicit advertising-consent event', () => {
    // eslint-disable-next-line no-new-func
    new Function(GPT_LOADER_CONTENT)();
    expect(document.querySelector(GPT_SELECTOR)).toBeNull();

    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    window.dispatchEvent(new CustomEvent(ADS_CONSENT_CHANGE_EVENT));

    expect(document.querySelector(GPT_SELECTOR)).not.toBeNull();
  });

  it('emits a synchronous page bootstrap without creating an ad slot', () => {
    expect(GPT_BOOTSTRAP_TAG).toBe('<script src="/assets/gpt-loader.js"></script>');
    expect(GPT_LOADER_CONTENT).toContain('enableServices');
    expect(GPT_LOADER_CONTENT).toContain('collapseDiv');
    expect(GPT_LOADER_CONTENT).not.toContain('adsbygoogle');
    expect(GPT_LOADER_CONTENT).not.toContain('<ins');
  });
});
