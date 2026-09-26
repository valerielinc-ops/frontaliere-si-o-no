/**
 * Funding Choices Offerwall contract.
 *
 * The custom newsletter choice is intentionally disabled globally. On every
 * job-board section the native page-level Offerwall (AdSense) is held until
 * the visitor clicks "Candidati", and on every other page the Offerwall alone
 * is suppressed; other Funding Choices messages remain available. Behaviour
 * is executed in tests/offerwall-click-gate-parity.test.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JOB_BOARD_SECTION_PATHNAME_RX } from '../scripts/lib/jobBoardSections.mjs';

const indexHtml = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
const appSource = readFileSync(resolve(__dirname, '..', 'App.tsx'), 'utf8');

const CONTROLLED_MESSAGING_BLOCK = (() => {
  const start = indexHtml.indexOf('controlledMessagingFunction');
  expect(start, 'Offerwall controlled messaging block must exist in index.html').toBeGreaterThan(-1);
  const end = indexHtml.indexOf('</script>', start);
  expect(end, 'closing </script> after controlled messaging block must exist').toBeGreaterThan(start);
  return indexHtml.slice(start, end);
})();

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

describe('Offerwall controlled messaging — held until "Candidati"', () => {
  it('holds the native Offerwall on every job-board section, suppresses it elsewhere', () => {
    expect(CONTROLLED_MESSAGING_BLOCK).toContain('controlledMessagingFunction');
    expect(CONTROLLED_MESSAGING_BLOCK).toContain(`/${JOB_BOARD_SECTION_PATHNAME_RX.source}/`);
    expect(CONTROLLED_MESSAGING_BLOCK).toContain("state: 'off_board'");
    expect(CONTROLLED_MESSAGING_BLOCK).not.toContain('cerca-lavoro-ticino');
    expect(CONTROLLED_MESSAGING_BLOCK).toContain('__ftOfferwallGate');
    expect(CONTROLLED_MESSAGING_BLOCK).toContain('w.release = function()');
    // Before a consent decision only the Offerwall is suppressed, so the CMP shows.
    expect(CONTROLLED_MESSAGING_BLOCK).toContain('message.proceed(false, [E.OFFERWALL])');
    expect(CONTROLLED_MESSAGING_BLOCK).toContain('message.proceed(true)');
  });

  it('allows only the bootstrap callback when the Funding Choices enum is unavailable', () => {
    expect(CONTROLLED_MESSAGING_BLOCK).not.toContain('E.OFFERWALL === undefined');
    expect(CONTROLLED_MESSAGING_BLOCK).toContain("typeof E.OFFERWALL !== 'number'");
    expect(CONTROLLED_MESSAGING_BLOCK).toContain('__ftOfferwallBootstrapComplete');
    expect(CONTROLLED_MESSAGING_BLOCK).toContain('message.proceed(false)');
    expect(CONTROLLED_MESSAGING_BLOCK).toContain('message.proceed(true)');
  });

  it('runs before the Funding Choices loader', () => {
    const controlledIdx = indexHtml.indexOf('controlledMessagingFunction');
    const fcLoaderIdx = indexHtml.indexOf('function loadFc()');
    expect(controlledIdx).toBeGreaterThan(-1);
    expect(fcLoaderIdx).toBeGreaterThan(-1);
    expect(controlledIdx).toBeLessThan(fcLoaderIdx);
  });
});
