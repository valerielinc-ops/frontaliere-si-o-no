/**
 * The click-only Offerwall gate ships in two sources: the readable inline
 * copy in index.html (SPA shell) and FC_JOBBOARD_OFFERWALL_GATE_JS, which
 * OFFERWALL_FC_SNIPPET and ADSENSE_LOADER_CONTENT carry to the static pages.
 * This file EXECUTES both against a fake Funding Choices, because identical
 * identifiers in both places prove nothing about identical behaviour.
 *
 * Contract for the Funding Choices call that carries OFFERWALL (the same
 * call also carries the GDPR consent message and the ad-block message):
 * - off the job-board sections (JOB_BOARD_SECTION_PATHNAME_RX, shared with
 *   JobBoard's rewarded surface): suppress only the Offerwall, whatever the
 *   consent state, and mark the gate `off_board`. AdSense includes the whole
 *   site (owner decision 2026-09-26), so this is what keeps the Offerwall off
 *   entry everywhere else; it never proceeds there;
 * - on every job-board section (all cantons, the Switzerland aggregator,
 *   it/en/de/fr), decision stored on both sides (our key AND a TC string in
 *   Funding Choices' FCCDCF cookie): hold the call until
 *   `__ftOfferwallGate.release()`;
 * - on a job-board section otherwise: suppress only the Offerwall, so the CMP
 *   shows at once (holding it kept the CMP off screen in the live probe), and
 *   mark the gate `suppressed`.
 * The first, enum-less call proceeds at once everywhere (holding it delayed
 * the display ads in the live probe). If a later call is still enum-less, it
 * fails closed because the Offerwall cannot be suppressed by type without its
 * enum value.
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
import { ADS_CONSENT_STORAGE_KEY } from '@/services/adsConsent';
import {
  JOB_BOARD_SECTION_PATHNAME_RX,
  JOB_BOARD_SECTION_PREFIX_SOURCE,
  isJobBoardSectionPathname,
} from '../scripts/lib/jobBoardSections.mjs';

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
  history: {
    pushState: (...args: unknown[]) => void;
    replaceState: (...args: unknown[]) => void;
  };
  addEventListener: (type: string, listener: () => void) => void;
  dispatchEvent: (event: { type: string }) => boolean;
  localStorage: { getItem: (key: string) => string | null };
  document: { cookie: string };
  googlefc?: {
    MessageTypeEnum?: Record<string, number>;
    controlledMessagingFunction?: (message: FakeMessage) => void;
    __ftOfferwallBootstrapComplete?: boolean;
    __ftOfferwallGateInstalled?: boolean;
  };
  __ftOfferwallGate?: { state?: string; release?: () => boolean };
};

// FCCDCF in the shape read live on the job board (25-09; ids synthetic),
// before and after the consent click: the TC slot is null until the visitor
// decides.
const FCCDCF_BEFORE_CONSENT = encodeURIComponent(
  '[null,null,null,null,null,null,[[32,"[\\"0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0\\",[1790311937,43000000]]"]]]',
);
const FCCDCF_AFTER_CONSENT = encodeURIComponent(
  '[null,null,null,["CQrGT8AQrGT8AEsACBITCyFoAP_gAEPgABCYMGoB7C7cbCFCCDJ3ILsEEABHQJAAYsAwBAIAA","1~"],null,null,[]]',
);
const cookieWith = (fccdcf: string) => `_ga=GA1.1.1; FCCDCF=${fccdcf}; FCNEC=x`;

function install(
  src: string,
  pathname: string,
  {
    consent = 'granted',
    cookie = cookieWith(FCCDCF_AFTER_CONSENT),
    preset,
  }: { consent?: string | null; cookie?: string; preset?: FakeWindow['googlefc'] } = {},
): FakeWindow {
  const store: Record<string, string> = consent ? { [ADS_CONSENT_STORAGE_KEY]: consent } : {};
  const listeners = new Map<string, Array<() => void>>();
  const win = {
    location: { pathname },
    history: {
      pushState: (_state: unknown, _title: unknown, url?: unknown) => {
        if (url !== undefined && url !== null) win.location.pathname = new URL(String(url), 'https://example.test').pathname;
      },
      replaceState: (_state: unknown, _title: unknown, url?: unknown) => {
        if (url !== undefined && url !== null) win.location.pathname = new URL(String(url), 'https://example.test').pathname;
      },
    },
    addEventListener: (type: string, listener: () => void) => {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    dispatchEvent: (event: { type: string }) => {
      for (const listener of listeners.get(event.type) ?? []) listener();
      return true;
    },
    localStorage: { getItem: (key: string) => store[key] ?? null },
    document: { cookie },
    googlefc: preset,
  } satisfies FakeWindow;
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win);
  return win;
}

function message(): FakeMessage {
  const calls: unknown[][] = [];
  let completed = false;
  return {
    calls,
    proceed: (...args: unknown[]) => {
      if (completed) throw new Error('Funding Choices messages are one-shot');
      completed = true;
      calls.push(args);
    },
  };
}

const ENUM = { OFFERWALL: 1, AD_BLOCKING: 2 };

// Every section shape the shared matcher documents: TI legacy, other cantons
// (hyphenated slugs too), the Switzerland aggregator, every locale (optional
// `/it|/en|/de|/fr` prefix), and the section root with and without its
// trailing slash.
const BOARD_PATHS = [
  '/cerca-lavoro-ticino/',
  '/cerca-lavoro-ticino',
  '/cerca-lavoro-ticino/stagista-supsi/',
  '/cerca-lavoro-ticino/tutti/page-2/',
  '/cerca-lavoro-argovia/',
  '/cerca-lavoro-san-gallo/infermiere-sg/',
  '/cerca-lavoro-svizzera/',
  '/en/find-jobs-ticino/some-job/',
  '/en/find-jobs-geneva/',
  '/en/find-jobs-switzerland/',
  '/de/jobs-im-tessin/stelle/',
  '/de/jobs-in-aargau/',
  '/de/jobs-in-der-waadt/',
  '/de/jobs-in-schweiz/',
  '/fr/trouver-emploi-tessin/',
  '/fr/trouver-emploi-vaud/emploi-x/',
  '/fr/trouver-emploi-suisse/',
  // Optional `/it/` prefix, as in jobBoardSeoPure's CANTON_LANDING_RE.
  '/it/cerca-lavoro-ticino/',
  '/it/cerca-lavoro-ticino/slug/',
];

// Pages AdSense now includes but where "Candidati" does not exist: articles,
// the generic job pages outside the sections, profession x city landings,
// employer profiles, and paths that only carry a section segment further down.
const OFF_BOARD_PATHS = [
  '/',
  '/articoli/fisco/',
  '/articoli-frontaliere/permesso-g/',
  '/lavoro/',
  '/lavoro/infermiere/',
  '/jobs-lugano-infermiere/',
  '/en/jobs-lugano-nurse/',
  '/cerca-lavoro/',
  '/blog/cerca-lavoro-ticino/',
  '/it/',
  '/es/cerca-lavoro-ticino/',
  '/en/',
  '/aziende/esempio-sa/',
];

describe('fixtures', () => {
  it('follow the shared job-board matcher', () => {
    for (const path of BOARD_PATHS) expect(isJobBoardSectionPathname(path), path).toBe(true);
    for (const path of OFF_BOARD_PATHS) expect(isJobBoardSectionPathname(path), path).toBe(false);
  });
});

describe.each(COPIES)('%s', (_name, src) => {
  it.each(OFF_BOARD_PATHS)('suppresses only the Offerwall off the job board (%s), even with consent stored', (path) => {
    const win = install(src, path);
    win.googlefc!.MessageTypeEnum = ENUM;
    const m = message();
    win.googlefc!.controlledMessagingFunction!(m);
    expect(m.calls).toEqual([[false, [ENUM.OFFERWALL]]]);
    expect(win.__ftOfferwallGate?.state).toBe('off_board');
    expect(win.__ftOfferwallGate?.release).toBeUndefined();
  });

  it('suppresses only the Offerwall off the job board without a consent decision too', () => {
    const win = install(src, '/articoli/fisco/', { consent: null, cookie: cookieWith(FCCDCF_BEFORE_CONSENT) });
    win.googlefc!.MessageTypeEnum = ENUM;
    const m = message();
    win.googlefc!.controlledMessagingFunction!(m);
    expect(m.calls).toEqual([[false, [ENUM.OFFERWALL]]]);
    expect(win.__ftOfferwallGate?.state).toBe('off_board');
  });

  it.each(['/articoli/fisco/', '/cerca-lavoro-ticino/tutti/page-2/', '/de/jobs-in-aargau/'])(
    'allows only the first enum-less call for bootstrap (%s)',
    (path) => {
      const win = install(src, path);
      const bootstrap = message();
      win.googlefc!.controlledMessagingFunction!(bootstrap);
      expect(bootstrap.calls).toEqual([[true]]);
      expect(win.googlefc!.__ftOfferwallBootstrapComplete).toBe(true);
      expect(win.__ftOfferwallGate).toBeUndefined();

      const unclassifiedOfferwall = message();
      win.googlefc!.controlledMessagingFunction!(unclassifiedOfferwall);
      expect(unclassifiedOfferwall.calls).toEqual([[false]]);
      expect(win.__ftOfferwallGate).toBeUndefined();
    },
  );

  it.each(['/articoli/fisco/', '/cerca-lavoro-ticino/tutti/page-2/'])('uses the typed gate after bootstrap (%s)', (path) => {
    const win = install(src, path);
    const bootstrap = message();
    win.googlefc!.controlledMessagingFunction!(bootstrap);
    expect(bootstrap.calls).toEqual([[true]]);

    win.googlefc!.MessageTypeEnum = ENUM;
    const typed = message();
    win.googlefc!.controlledMessagingFunction!(typed);
    if (isJobBoardSectionPathname(path)) {
      expect(typed.calls).toEqual([]);
      expect(win.__ftOfferwallGate?.state).toBe('held');
    } else {
      expect(typed.calls).toEqual([[false, [ENUM.OFFERWALL]]]);
      expect(win.__ftOfferwallGate?.state).toBe('off_board');
    }
  });

  it.each([
    ['no decision anywhere', { consent: null, cookie: cookieWith(FCCDCF_BEFORE_CONSENT) }],
    ['our key, but Funding Choices has no TC string', { consent: 'granted', cookie: cookieWith(FCCDCF_BEFORE_CONSENT) }],
    ['our key, but no FCCDCF cookie at all', { consent: 'granted', cookie: '_ga=GA1.1.1' }],
    ['our key, FCCDCF undecodable', { consent: 'granted', cookie: cookieWith('%E0%A4%A') }],
    ['a TC string, but not our key', { consent: null }],
  ])('%s: lets the CMP show, suppresses only the Offerwall', (_case, opts) => {
    for (const path of ['/cerca-lavoro-ticino/stagista-supsi/', '/fr/trouver-emploi-vaud/emploi-x/']) {
      const win = install(src, path, opts);
      win.googlefc!.MessageTypeEnum = ENUM;
      const m = message();
      win.googlefc!.controlledMessagingFunction!(m);
      expect(m.calls, path).toEqual([[false, [ENUM.OFFERWALL]]]);
      expect(win.__ftOfferwallGate?.state, path).toBe('suppressed');
    }
  });

  it.each(['granted', 'denied'])('with a decision stored on both sides (%s), holds the Offerwall call until release()', (consent) => {
    const win = install(src, '/cerca-lavoro-ticino/stagista-supsi/', { consent });
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

  it.each(BOARD_PATHS)('holds the Offerwall call on every job-board section (%s)', (path) => {
    const win = install(src, path);
    win.googlefc!.MessageTypeEnum = ENUM;
    const m = message();
    win.googlefc!.controlledMessagingFunction!(m);
    expect(m.calls).toEqual([]);
    expect(win.__ftOfferwallGate?.state).toBe('held');
    expect(win.__ftOfferwallGate!.release!()).toBe(true);
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

  it('composes a pre-existing callback without bypassing the Offerwall gate', () => {
    const existing = (delegated: FakeMessage) => delegated.proceed(true);
    const win = install(src, '/cerca-lavoro-ticino/', { preset: { controlledMessagingFunction: existing } });
    expect(win.googlefc!.controlledMessagingFunction).not.toBe(existing);
    win.googlefc!.MessageTypeEnum = ENUM;
    const m = message();
    win.googlefc!.controlledMessagingFunction!(m);
    expect(m.calls).toEqual([]);
    expect(win.__ftOfferwallGate?.state).toBe('held');
    expect(win.__ftOfferwallGate!.release!()).toBe(true);
    expect(m.calls).toEqual([[true]]);
  });

  it('preserves a pre-existing type-specific decision while adding the Offerwall restriction', () => {
    const existing = (delegated: FakeMessage) => delegated.proceed(false, [ENUM.AD_BLOCKING]);
    const win = install(src, '/articoli/fisco/', { preset: { controlledMessagingFunction: existing } });
    win.googlefc!.MessageTypeEnum = ENUM;
    const m = message();
    win.googlefc!.controlledMessagingFunction!(m);
    expect(m.calls).toEqual([[false, [ENUM.AD_BLOCKING, ENUM.OFFERWALL]]]);
  });

  it('follows pushState, replaceState, and popstate without reinstalling the callback', () => {
    const win = install(src, '/articoli/fisco/');
    const callback = win.googlefc!.controlledMessagingFunction!;
    win.googlefc!.MessageTypeEnum = ENUM;

    const initial = message();
    callback(initial);
    expect(initial.calls).toEqual([[false, [ENUM.OFFERWALL]]]);
    expect(win.__ftOfferwallGate?.state).toBe('off_board');

    win.history.pushState({}, '', '/cerca-lavoro-ticino/');
    const pushed = message();
    callback(pushed);
    expect(pushed.calls).toEqual([]);
    expect(win.__ftOfferwallGate?.state).toBe('held');

    win.history.replaceState({}, '', '/articoli/fisco/');
    expect(pushed.calls).toEqual([[false, [ENUM.OFFERWALL]]]);
    expect(win.__ftOfferwallGate?.state).toBe('off_board');

    win.location.pathname = '/cerca-lavoro-ticino/';
    win.dispatchEvent({ type: 'popstate' });
    const popped = message();
    callback(popped);
    expect(popped.calls).toEqual([]);
    expect(win.__ftOfferwallGate?.state).toBe('held');

    win.location.pathname = '/articoli/fisco/';
    win.dispatchEvent({ type: 'popstate' });
    expect(popped.calls).toEqual([[false, [ENUM.OFFERWALL]]]);
    expect(win.__ftOfferwallGate?.state).toBe('off_board');
    expect(win.googlefc!.controlledMessagingFunction).toBe(callback);
  });

  it('waits for a fresh Offerwall callback when entering the job board', () => {
    const win = install(src, '/');
    const callback = win.googlefc!.controlledMessagingFunction!;

    const first = message();
    callback(first);
    expect(first.calls).toEqual([[true]]);

    win.googlefc!.MessageTypeEnum = ENUM;
    const offBoardOfferwall = message();
    callback(offBoardOfferwall);
    expect(offBoardOfferwall.calls).toEqual([[false, [ENUM.OFFERWALL]]]);
    expect(win.__ftOfferwallGate?.state).toBe('off_board');

    win.history.pushState({}, '', '/it/cerca-lavoro-ticino/');
    expect(win.__ftOfferwallGate?.state).toBe('idle');
    expect(win.__ftOfferwallGate!.release).toBeUndefined();

    const destinationOfferwall = message();
    callback(destinationOfferwall);
    expect(destinationOfferwall.calls).toEqual([]);
    expect(win.__ftOfferwallGate?.state).toBe('held');
    expect(win.__ftOfferwallGate!.release!()).toBe(true);
    expect(offBoardOfferwall.calls).toEqual([[false, [ENUM.OFFERWALL]]]);
    expect(destinationOfferwall.calls).toEqual([[true]]);
    expect([offBoardOfferwall, destinationOfferwall]
      .flatMap((m) => m.calls)
      .filter(([proceed]) => proceed === true)).toHaveLength(1);
  });
});

/** The path regex literal a gate copy tests `pathname` against. */
function gatePathRegex(src: string): RegExp {
  const m = src.match(/function\s+isJobBoardPath\s*\(\)\s*\{[\s\S]*?return\s*\/((?:\\.|[^/\\\n])+)\/\.test\(p\)/);
  if (!m) throw new Error('gate copy no longer tests the pathname with a regex literal');
  return new RegExp(m[1]);
}

describe('job-board path drift', () => {
  it.each(COPIES)('%s uses the shared job-board section matcher', (_name, src) => {
    expect(gatePathRegex(src).source).toBe(JOB_BOARD_SECTION_PATHNAME_RX.source);
    expect(gatePathRegex(src).source).toContain(`(?:${JOB_BOARD_SECTION_PREFIX_SOURCE})-`);
  });

  it('every carrier embeds the same path regex', () => {
    const literal = `/${JOB_BOARD_SECTION_PATHNAME_RX.source}/`;
    expect(FC_JOBBOARD_OFFERWALL_GATE_JS).toContain(literal);
    expect(OFFERWALL_FC_SNIPPET).toContain(literal);
    expect(ADSENSE_LOADER_CONTENT).toContain(literal);
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

  it('index.html reads the same consent key the bridge writes', () => {
    expect(extractIndexHtmlGate()).toContain(`'${ADS_CONSENT_STORAGE_KEY}'`);
  });
});
