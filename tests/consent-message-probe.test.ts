/**
 * scripts/probe-live-consent-message.mjs asks the LIVE Funding Choices
 * whether a new visitor is offered the GDPR consent message. These tests pin
 * its two offline halves:
 * - the verdict (scripts/lib/consent-message-probe.mjs);
 * - the in-page recorder, executed next to the REAL Offerwall gate (both
 *   copies) against a fake Funding Choices, so the probe provably reads the
 *   decision the gate gives, and fails on the 2026-09-27 regression (#9974:
 *   a number-only enum check answered proceed(false) to the string enum).
 * Plus the workflow wiring: the probe is a failing step of validate-live.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FC_JOBBOARD_OFFERWALL_GATE_JS } from '@/build-plugins/constants';
import {
  CMF_RECORDER_INIT_JS,
  FC_PREVIEW_QUERY,
  bestVerdict,
  classifyConsentProbe,
} from '../scripts/lib/consent-message-probe.mjs';
import { probeUrl } from '../scripts/probe-live-consent-message.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(resolve(REPO_ROOT, 'index.html'), 'utf8');
const validateLive = readFileSync(resolve(REPO_ROOT, '.github/workflows/post-deploy-validate-live.yml'), 'utf8');

function extractIndexHtmlGate(): string {
  const m = indexHtml.match(/<script>((?:(?!<\/script>)[\s\S])*__ftOfferwallGate[\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html no longer contains the __ftOfferwallGate script');
  return m[1];
}

// Re-introduce the #9974 check (number only) in a copy of the gate.
function numberOnly(src: string): string {
  const broken = src.replace(/\s*&&\s*typeof E\.OFFERWALL\s*!==\s*'string'/, '');
  if (broken === src) throw new Error('gate no longer carries the string clause this test removes');
  return broken;
}

type Call = { enumKeys: number; offerwallType: string; decision: { allow: boolean; types: unknown[] | null } | null };
type Msg = { proceed: (...args: unknown[]) => void };
type Win = {
  location: { pathname: string };
  history: { pushState: () => void; replaceState: () => void };
  addEventListener: () => void;
  localStorage: { getItem: () => string | null };
  document: { cookie: string };
  googlefc?: { MessageTypeEnum?: Record<string, string | number>; controlledMessagingFunction?: (m: Msg) => void };
  __ftConsentProbe?: { calls: Call[] };
};

// A clean browser profile, as the probe uses: no consent decision anywhere.
function visit(gateSrc: string, pathname: string, ENUM: Record<string, string | number>): Call[] {
  const win: Win = {
    location: { pathname },
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: () => {},
    localStorage: { getItem: () => null },
    document: { cookie: '' },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', CMF_RECORDER_INIT_JS)(win);
  // eslint-disable-next-line no-new-func
  new Function('window', gateSrc)(win);
  const fc = win.googlefc!;
  // Funding Choices calls twice: first with an empty enum, then populated.
  fc.controlledMessagingFunction!({ proceed: () => {} });
  fc.MessageTypeEnum = ENUM;
  fc.controlledMessagingFunction!({ proceed: () => {} });
  return win.__ftConsentProbe!.calls;
}

const COPIES: Array<[string, string]> = [
  ['index.html inline copy', extractIndexHtmlGate()],
  ['FC_JOBBOARD_OFFERWALL_GATE_JS', FC_JOBBOARD_OFFERWALL_GATE_JS],
];
const LIVE_ENUM = { OFFERWALL: 'offerwall', AD_BLOCKING: 'ad_blocking' };
const NUMERIC_ENUM = { OFFERWALL: 1, AD_BLOCKING: 2 };
const PATHS = ['/', '/cerca-lavoro-ticino/', '/cerca-lavoro-zurigo/'];

describe('recorder next to the real gate', () => {
  for (const [copy, src] of COPIES) {
    for (const [shape, ENUM] of [['string enum', LIVE_ENUM], ['numeric enum', NUMERIC_ENUM]] as const) {
      for (const path of PATHS) {
        it(`${copy}, ${shape}, ${path}: records one call per Funding Choices call and no fail`, () => {
          const calls = visit(src, path, ENUM);
          expect(calls).toHaveLength(2);
          expect(calls[0]).toMatchObject({ enumKeys: 0, decision: { allow: true, types: null } });
          expect(calls[1]).toMatchObject({ enumKeys: 2, decision: { allow: false, types: [ENUM.OFFERWALL] } });
          // Offline there is no dialog to see; the verdict must still not fail.
          expect(classifyConsentProbe({ calls, fcRequested: true, dialogVisible: false }).verdict).toBe('inconclusive');
          expect(classifyConsentProbe({ calls, fcRequested: true, dialogVisible: true }).verdict).toBe('pass');
        });
      }
    }

    it(`${copy}: the #9974 number-only check fails the probe on the live string enum`, () => {
      for (const path of PATHS) {
        const calls = visit(numberOnly(src), path, LIVE_ENUM);
        expect(calls[1]).toMatchObject({ enumKeys: 2, offerwallType: 'string', decision: { allow: false, types: null } });
        const v = classifyConsentProbe({ calls, fcRequested: true, dialogVisible: false });
        expect(v.verdict, path).toBe('fail');
        expect(v.reason).toBe('blanket_suppression');
      }
    });
  }

  it('records only the outermost function when the page composes callbacks', () => {
    const win: Win = {
      location: { pathname: '/' },
      history: { pushState: () => {}, replaceState: () => {} },
      addEventListener: () => {},
      localStorage: { getItem: () => null },
      document: { cookie: '' },
    };
    // eslint-disable-next-line no-new-func
    new Function('window', CMF_RECORDER_INIT_JS)(win);
    const fc = win.googlefc!;
    fc.controlledMessagingFunction = (m: Msg) => m.proceed(true);
    const inner = fc.controlledMessagingFunction!;
    fc.controlledMessagingFunction = (m: Msg) => inner(m);
    fc.MessageTypeEnum = LIVE_ENUM;
    fc.controlledMessagingFunction!({ proceed: () => {} });
    expect(win.__ftConsentProbe!.calls).toEqual([{ enumKeys: 2, offerwallType: 'string', decision: { allow: true, types: null } }]);
  });
});

describe('classifyConsentProbe', () => {
  const populated = (decision: Call['decision']): Call => ({ enumKeys: 2, offerwallType: 'string', decision });
  const bootstrap: Call = { enumKeys: 0, offerwallType: 'undefined', decision: { allow: true, types: null } };

  it('fails a blanket suppression even when a dialog is somehow visible', () => {
    const v = classifyConsentProbe({ calls: [bootstrap, populated({ allow: false, types: [] })], fcRequested: true, dialogVisible: true });
    expect(v).toMatchObject({ verdict: 'fail', reason: 'blanket_suppression' });
  });

  it('fails a populated call that never gets proceed()', () => {
    expect(classifyConsentProbe({ calls: [bootstrap, populated(null)], fcRequested: true }).reason).toBe('unanswered');
  });

  it('fails when Funding Choices is never requested', () => {
    expect(classifyConsentProbe({ calls: [], fcRequested: false, dialogVisible: false }).reason).toBe('fc_not_requested');
  });

  it('passes when the consent message is on screen', () => {
    const v = classifyConsentProbe({ calls: [bootstrap, populated({ allow: false, types: ['offerwall'] })], fcRequested: true, dialogVisible: true });
    expect(v.verdict).toBe('pass');
  });

  it('is inconclusive, not failed, when Funding Choices offers nothing', () => {
    expect(classifyConsentProbe({ calls: [bootstrap], fcRequested: true, dialogVisible: false }))
      .toMatchObject({ verdict: 'inconclusive', reason: 'no_message_offered' });
  });

  it('ignores the enum-less bootstrap call even when it is refused', () => {
    const refusedBootstrap: Call = { enumKeys: 0, offerwallType: 'undefined', decision: { allow: false, types: null } };
    expect(classifyConsentProbe({ calls: [refusedBootstrap], fcRequested: true, dialogVisible: true }).verdict).toBe('pass');
  });

  it('keeps the best attempt, so a retry clears a flake but not a steady fail', () => {
    const fail = { verdict: 'fail' as const, reason: 'blanket_suppression', detail: '' };
    const pass = { verdict: 'pass' as const, reason: 'consent_visible', detail: '' };
    expect(bestVerdict([fail, pass])).toBe(pass);
    expect(bestVerdict([fail, fail])).toBe(fail);
  });
});

describe('probeUrl', () => {
  it('adds the Funding Choices preview query and a cache-busting stamp', () => {
    expect(probeUrl('https://frontaliereticino.ch/', '/cerca-lavoro-ticino/', 42)).toBe(
      `https://frontaliereticino.ch/cerca-lavoro-ticino/?${FC_PREVIEW_QUERY}&_ftprobe=42`,
    );
  });
});

describe('post-deploy-validate-live.yml', () => {
  const stepStart = validateLive.indexOf('- name: Consent message reaches new visitors');
  const step = validateLive.slice(stepStart, validateLive.indexOf('\n      - name:', stepStart + 1));

  it('runs the probe as a failing step after the propagation wait', () => {
    expect(stepStart).toBeGreaterThan(validateLive.indexOf('- name: Fail on propagation timeout'));
    expect(step).toContain('node scripts/probe-live-consent-message.mjs');
    expect(step).toContain('PLAYWRIGHT_BROWSERS_PATH: /home/runner/.cache/ms-playwright');
    expect(step).not.toMatch(/continue-on-error:\s*true/);
  });
});
