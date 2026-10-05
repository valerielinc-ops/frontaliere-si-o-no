// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/cerca-lavoro-ticino/" }

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GPT_BOOTSTRAP_TAG,
  GPT_LOADER_CONTENT,
  GPT_SCRIPT_SRC,
  JOB_BOARD_HEAD_TAGS,
  JOB_BOARD_FC_LOADER_FILENAME,
  JOB_BOARD_FC_LOADER_TAG,
  jobBoardHeadTags,
  isJobBoardPageUrl,
} from '@/build-plugins/jobBoardGpt';
import {
  FC_JOBBOARD_OFFERWALL_GATE_JS,
  EARLY_BOOT_SCRIPT,
  OFFERWALL_FC_SCRIPT_CONTENT,
  OFFERWALL_FC_SNIPPET,
  POSTHOG_SNIPPET,
} from '@/build-plugins/constants';
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
    expect(isJobBoardPageUrl('/jobs-lugano-infermiere/')).toBe(false);
    expect(isJobBoardPageUrl('/blog/cerca-lavoro-ticino/')).toBe(false);
  });

  it('loads GPT only after the explicit advertising-consent event', () => {
    // eslint-disable-next-line no-new-func
    new Function(GPT_LOADER_CONTENT)();
    expect(document.querySelector(GPT_SELECTOR)).toBeNull();

    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    window.dispatchEvent(new CustomEvent(ADS_CONSENT_CHANGE_EVENT));

    expect(document.querySelector(GPT_SELECTOR)).not.toBeNull();
  });

  it('emits a deferred page bootstrap without creating an ad slot', () => {
    expect(GPT_BOOTSTRAP_TAG).toBe('<script defer src="/assets/gpt-loader.js"></script>');
    expect(GPT_LOADER_CONTENT).toContain('enableServices');
    expect(GPT_LOADER_CONTENT).toContain('collapseDiv');
    expect(GPT_LOADER_CONTENT).not.toContain('adsbygoogle');
    expect(GPT_LOADER_CONTENT).not.toContain('<ins');
  });

  it('keeps GPT and Funding Choices together in cacheable carriers for every job-board head', () => {
    const tags = jobBoardHeadTags('/cerca-lavoro-zurigo/');
    expect(tags).toBe(JOB_BOARD_HEAD_TAGS);
    expect(tags).toContain(GPT_BOOTSTRAP_TAG);
    expect(tags).toContain(JOB_BOARD_FC_LOADER_TAG);
    expect(tags.indexOf(GPT_BOOTSTRAP_TAG)).toBeLessThan(tags.indexOf(JOB_BOARD_FC_LOADER_TAG));
    expect(JOB_BOARD_FC_LOADER_FILENAME).toBe('job-board-fc-loader.js');
    expect(tags).not.toContain(OFFERWALL_FC_SNIPPET);
    expect(OFFERWALL_FC_SCRIPT_CONTENT).toContain('data-fc-loader');
    expect(jobBoardHeadTags('/')).toBe('');
  });

  it('defers analytics and job-board carriers while preserving early-boot timing', () => {
    expect(POSTHOG_SNIPPET).toBe('<script defer src="/assets/posthog-init.js"></script>');
    expect(EARLY_BOOT_SCRIPT).toBe('<script src="/assets/early-boot.js"></script>');
  });

  it('installs the click-only Offerwall gate before it can inject GPT', () => {
    // The deferred carrier runs before DOMContentLoaded, ahead of the user
    // interaction that can release the rewarded flow.
    expect(GPT_LOADER_CONTENT.startsWith(FC_JOBBOARD_OFFERWALL_GATE_JS)).toBe(true);
    const win = window as unknown as { googlefc?: { controlledMessagingFunction?: unknown } };
    delete win.googlefc;
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    // eslint-disable-next-line no-new-func
    new Function(GPT_LOADER_CONTENT)();
    expect(typeof win.googlefc?.controlledMessagingFunction).toBe('function');
    expect(document.querySelector(GPT_SELECTOR)).not.toBeNull();
    delete win.googlefc;
  });
});
