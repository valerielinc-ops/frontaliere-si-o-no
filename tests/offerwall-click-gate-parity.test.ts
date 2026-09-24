/**
 * The click-only Offerwall gate ships in two sources: the readable inline
 * copy in index.html (SPA shell) and FC_JOBBOARD_OFFERWALL_GATE_JS, which
 * OFFERWALL_FC_SNIPPET and ADSENSE_LOADER_CONTENT carry to the static pages.
 * This file EXECUTES both against a fake Funding Choices, because identical
 * identifiers in both places prove nothing about identical behaviour.
 *
 * Contract: on /cerca-lavoro-ticino pages the Funding Choices call that
 * carries OFFERWALL is held until `window.__ftOfferwallGate.release()`; every
 * other call proceeds at once (holding the first, enum-less call delayed the
 * display ads in the live probe).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ADSENSE_LOADER_CONTENT,
  FC_JOBBOARD_OFFERWALL_GATE_JS,
  OFFERWALL_FC_SNIPPET,
} from '@/build-plugins/constants';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(resolve(REPO_ROOT, 'index.html'), 'utf8');

function extractIndexHtmlGate(): string {
  const m = indexHtml.match(/<script>((?:(?!<\/script>)[\s\S])*__ftOfferwallGate[\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html no longer contains the __ftOfferwallGate script');
  return m[1];
}

const COPIES: Array<[string, string]> = [
  ['index.html inline copy', extractIndexHtmlGate()],
  ['FC_JOBBOARD_OFFERWALL_GATE_JS', FC_JOBBOARD_OFFERWALL_GATE_JS],
];

type FakeMessage = { proceed: (...args: unknown[]) => void; calls: unknown[][] };
type FakeWindow = {
  location: { pathname: string };
  googlefc?: {
    MessageTypeEnum?: Record<string, number>;
    controlledMessagingFunction?: (message: FakeMessage) => void;
  };
  __ftOfferwallGate?: { state?: string; release?: () => boolean };
};

function install(src: string, pathname: string, preset?: FakeWindow['googlefc']): FakeWindow {
  const win: FakeWindow = { location: { pathname }, googlefc: preset };
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win);
  return win;
}

function message(): FakeMessage {
  const calls: unknown[][] = [];
  return { calls, proceed: (...args: unknown[]) => calls.push(args) };
}

const ENUM = { OFFERWALL: 1, AD_BLOCKING: 2 };

describe.each(COPIES)('%s', (_name, src) => {
  it('proceeds every message outside the Italian job board', () => {
    const win = install(src, '/articoli/fisco/');
    win.googlefc!.MessageTypeEnum = ENUM;
    const m = message();
    win.googlefc!.controlledMessagingFunction!(m);
    expect(m.calls).toEqual([[true]]);
    expect(win.__ftOfferwallGate).toBeUndefined();
  });

  it('proceeds the first, enum-less call on the job board at once', () => {
    const win = install(src, '/cerca-lavoro-ticino/tutti/page-2/');
    const m = message();
    win.googlefc!.controlledMessagingFunction!(m);
    expect(m.calls).toEqual([[true]]);
  });

  it('holds the Offerwall call on the job board until release()', () => {
    const win = install(src, '/cerca-lavoro-ticino/stagista-supsi/');
    win.googlefc!.MessageTypeEnum = ENUM;
    const m = message();
    win.googlefc!.controlledMessagingFunction!(m);
    expect(m.calls).toEqual([]);
    expect(win.__ftOfferwallGate?.state).toBe('held');

    expect(win.__ftOfferwallGate!.release!()).toBe(true);
    expect(m.calls).toEqual([[true]]);
    expect(win.__ftOfferwallGate?.state).toBe('released');
    expect(win.__ftOfferwallGate!.release!()).toBe(false);
    expect(m.calls).toEqual([[true]]);
  });

  it('releases every held call, and proceeds later calls once released', () => {
    const win = install(src, '/cerca-lavoro-ticino/');
    win.googlefc!.MessageTypeEnum = ENUM;
    const first = message();
    const second = message();
    win.googlefc!.controlledMessagingFunction!(first);
    win.googlefc!.controlledMessagingFunction!(second);
    win.__ftOfferwallGate!.release!();
    expect(first.calls).toEqual([[true]]);
    expect(second.calls).toEqual([[true]]);

    const late = message();
    win.googlefc!.controlledMessagingFunction!(late);
    expect(late.calls).toEqual([[true]]);
  });

  it('matches the section only, not look-alike paths', () => {
    const win = install(src, '/cerca-lavoro-ticinese/');
    win.googlefc!.MessageTypeEnum = ENUM;
    const m = message();
    win.googlefc!.controlledMessagingFunction!(m);
    expect(m.calls).toEqual([[true]]);
  });

  it('steps aside when another copy already installed the gate', () => {
    const existing = () => {};
    const win = install(src, '/cerca-lavoro-ticino/', { controlledMessagingFunction: existing });
    expect(win.googlefc!.controlledMessagingFunction).toBe(existing);
  });
});

describe('gate carriers', () => {
  it('the shared loader installs the gate before it can load Funding Choices', () => {
    const gateAt = ADSENSE_LOADER_CONTENT.indexOf(FC_JOBBOARD_OFFERWALL_GATE_JS);
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(ADSENSE_LOADER_CONTENT.indexOf('function ensureFc()'));
    // Before the bot and no-ads early returns: whatever else loads Funding
    // Choices on the page finds the gate installed.
    expect(gateAt).toBeLessThan(ADSENSE_LOADER_CONTENT.indexOf('reader_noads_active'));
  });

  it('the static snippet installs the gate before its Funding Choices loader', () => {
    const gateAt = OFFERWALL_FC_SNIPPET.indexOf(FC_JOBBOARD_OFFERWALL_GATE_JS);
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(OFFERWALL_FC_SNIPPET.indexOf('function loadFc()'));
  });

  it('index.html installs the gate before its Funding Choices loader', () => {
    expect(indexHtml.indexOf('__ftOfferwallGate')).toBeLessThan(indexHtml.indexOf('function loadFc()'));
  });

  it('no copy suppresses the Offerwall outright any more', () => {
    for (const src of [indexHtml, OFFERWALL_FC_SNIPPET, ADSENSE_LOADER_CONTENT]) {
      expect(src).not.toMatch(/proceed\(\s*false/);
    }
  });
});
