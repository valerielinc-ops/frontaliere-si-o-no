/**
 * Funding Choices Offerwall contract.
 *
 * The custom newsletter choice is intentionally disabled globally. The Italian
 * job board's Offerwall is the AdSense-hosted one (Privacy & messaging moved
 * from Ad Manager to AdSense on 2026-09-24): its rewarded ad is the site's
 * only rewarded demand, so no controlledMessagingFunction may filter it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
const appSource = readFileSync(resolve(__dirname, '..', 'App.tsx'), 'utf8');

describe('Offerwall custom-choice registry — globally disabled', () => {
  it('does not emit a custom newsletter choice in the static shell', () => {
    expect(indexHtml).not.toContain('customchoice');
    expect(indexHtml).not.toContain('__ftOfferwallSubscribe');
  });

  it('does not mount the legacy newsletter Offerwall gate', () => {
    expect(appSource).not.toContain('OfferwallNewsletterGate');
    expect(appSource).not.toContain('offerwall-gate');
  });

  it('keeps the Funding Choices loader in the shell', () => {
    expect(indexHtml).toContain('function loadFc()');
    expect(indexHtml).toContain('fundingchoicesmessages.google.com/i/');
    expect(indexHtml).toContain('data-fc-loader');
  });
});

describe('Offerwall — AdSense rewarded demand on the job board', () => {
  it('does not install a controlledMessagingFunction that could filter it', () => {
    expect(indexHtml).not.toMatch(/controlledMessagingFunction\s*=/);
    expect(indexHtml).not.toContain('E.OFFERWALL');
    expect(indexHtml).not.toContain('proceed(false');
  });
});
