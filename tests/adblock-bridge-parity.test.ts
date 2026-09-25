/**
 * The AD_BLOCK_DATA_READY bridge has to exist in BOTH places that ship
 * JavaScript to a page, and it has to BEHAVE the same in both.
 *
 * index.html covers the SPA entry. The ~200k generated SEO and job pages never
 * clone it — they load ads from the shared dist/assets/adsense-loader.js built
 * from ADSENSE_LOADER_CONTENT. AdBlockGate mounts on every route, so a bridge
 * present only in index.html would leave the gate on its weak local probe
 * exactly where it fires and where the ad revenue is.
 *
 * Why this file EXECUTES both copies instead of grepping them: a parity test
 * that only checks that the same identifiers appear in both places is green on
 * a bridge whose logic has diverged. Measured on this branch before the fix —
 * the five substring assertions passed while the loader copy answered
 * `{blocked:true, adsAllowed:true}` on degenerate Funding Choices state and
 * index.html answered `{blocked:false, adsAllowed:false}`. Same shape as the
 * SiteShellContract: a contract with no import form is invisible to guards that
 * follow imports.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADSENSE_LOADER_CONTENT,
  FC_ADBLOCK_BRIDGE_JS,
  FC_ADBLOCK_SIGNAL_EVENT,
} from '@/build-plugins/constants';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(resolve(REPO_ROOT, 'index.html'), 'utf8');
const detection = readFileSync(resolve(REPO_ROOT, 'services/adBlockDetection.ts'), 'utf8');

/** The inline <script> in index.html that registers the AD_BLOCK_DATA_READY callback. */
function extractIndexHtmlBridge(): string {
  const m = indexHtml.match(
    /<script>((?:(?!<\/script>)[\s\S])*__ftFcAdBlockBridge[\s\S]*?)<\/script>/,
  );
  if (!m) throw new Error('index.html no longer contains the __ftFcAdBlockBridge script');
  return m[1];
}

type BridgeResult = {
  blocked?: unknown;
  adsAllowed?: unknown;
  status?: unknown;
  allowAds?: unknown;
  /** The bridge swallowed the failure and stashed nothing — a valid outcome. */
  noPayload?: true;
  events?: number;
};

/**
 * Run one bridge source against a fake `window` whose `googlefc` is in the
 * given state, fire the AD_BLOCK_DATA_READY callback, and report what landed
 * on `window.__ftAdBlock`.
 */
function runBridge(src: string, googlefc: Record<string, unknown>): BridgeResult {
  let events = 0;
  const win: Record<string, unknown> = {
    googlefc,
    dispatchEvent: () => {
      events += 1;
      return true;
    },
  };
  const FakeCustomEvent = function FakeCustomEvent(this: unknown) {
    /* the bridge only constructs it */
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'CustomEvent', src)(win, FakeCustomEvent);

  const queue = (win.googlefc as { callbackQueue?: Array<Record<string, () => void>> })
    .callbackQueue;
  expect(queue, 'the bridge must register on googlefc.callbackQueue').toBeTruthy();
  const entry = queue!.find((e) => typeof e.AD_BLOCK_DATA_READY === 'function');
  expect(entry, 'the bridge must register an AD_BLOCK_DATA_READY callback').toBeTruthy();
  entry!.AD_BLOCK_DATA_READY();

  const payload = win.__ftAdBlock as Record<string, unknown> | undefined;
  if (!payload) return { noPayload: true, events };
  return {
    blocked: payload.blocked,
    adsAllowed: payload.adsAllowed,
    status: payload.status,
    allowAds: payload.allowAds,
    events,
  };
}

const FULL_STATUS_ENUM = {
  UNKNOWN: 0,
  NO_AD_BLOCKER: 1,
  EXTENSION_LEVEL_AD_BLOCKER: 2,
  NETWORK_LEVEL_AD_BLOCKER: 3,
};
const FULL_ALLOW_ENUM = { UNKNOWN: 0, ADS_ALLOWED: 1, ADS_NOT_ALLOWED: 2 };

type Scenario = {
  name: string;
  googlefc: () => Record<string, unknown>;
  /** Expected verdict, or 'no-payload' when the bridge is meant to stash nothing. */
  expected: { blocked: boolean; adsAllowed: boolean } | 'no-payload';
};

const SCENARIOS: Scenario[] = [
  {
    name: 'extension-level blocker, ads not allowed',
    googlefc: () => ({
      AdBlockerStatusEnum: FULL_STATUS_ENUM,
      AllowAdsStatusEnum: FULL_ALLOW_ENUM,
      getAdBlockerStatus: () => FULL_STATUS_ENUM.EXTENSION_LEVEL_AD_BLOCKER,
      getAllowAdsStatus: () => FULL_ALLOW_ENUM.ADS_NOT_ALLOWED,
    }),
    expected: { blocked: true, adsAllowed: false },
  },
  {
    name: 'network-level blocker, ads not allowed',
    googlefc: () => ({
      AdBlockerStatusEnum: FULL_STATUS_ENUM,
      AllowAdsStatusEnum: FULL_ALLOW_ENUM,
      getAdBlockerStatus: () => FULL_STATUS_ENUM.NETWORK_LEVEL_AD_BLOCKER,
      getAllowAdsStatus: () => FULL_ALLOW_ENUM.ADS_NOT_ALLOWED,
    }),
    expected: { blocked: true, adsAllowed: false },
  },
  {
    name: 'no blocker at all',
    googlefc: () => ({
      AdBlockerStatusEnum: FULL_STATUS_ENUM,
      AllowAdsStatusEnum: FULL_ALLOW_ENUM,
      getAdBlockerStatus: () => FULL_STATUS_ENUM.NO_AD_BLOCKER,
      getAllowAdsStatus: () => FULL_ALLOW_ENUM.ADS_NOT_ALLOWED,
    }),
    expected: { blocked: false, adsAllowed: false },
  },
  {
    name: 'blocker present but the visitor allowlisted us',
    googlefc: () => ({
      AdBlockerStatusEnum: FULL_STATUS_ENUM,
      AllowAdsStatusEnum: FULL_ALLOW_ENUM,
      getAdBlockerStatus: () => FULL_STATUS_ENUM.EXTENSION_LEVEL_AD_BLOCKER,
      getAllowAdsStatus: () => FULL_ALLOW_ENUM.ADS_ALLOWED,
    }),
    expected: { blocked: true, adsAllowed: true },
  },
];

/**
 * The degenerate states. Every one of these must answer with the two SAFE
 * negatives. `blocked:true` here gates a visitor who blocks nothing;
 * `adsAllowed:true` here permanently un-gates a visitor who blocks everything
 * (AdBlockGate returns early on `adsAllowed` before it ever looks at
 * `blocked`), and it also survives the `live` re-read, so it cannot be
 * corrected later in the page's life.
 */
const DEGENERATE: Scenario[] = [
  {
    name: 'enums absent, getters return undefined',
    googlefc: () => ({
      getAdBlockerStatus: () => undefined,
      getAllowAdsStatus: () => undefined,
    }),
    expected: { blocked: false, adsAllowed: false },
  },
  {
    name: 'enums partially populated, getters return undefined',
    googlefc: () => ({
      AdBlockerStatusEnum: { NO_AD_BLOCKER: 1 },
      AllowAdsStatusEnum: {},
      getAdBlockerStatus: () => undefined,
      getAllowAdsStatus: () => undefined,
    }),
    expected: { blocked: false, adsAllowed: false },
  },
  {
    name: 'enums present, getters return undefined',
    googlefc: () => ({
      AdBlockerStatusEnum: FULL_STATUS_ENUM,
      AllowAdsStatusEnum: FULL_ALLOW_ENUM,
      getAdBlockerStatus: () => undefined,
      getAllowAdsStatus: () => undefined,
    }),
    expected: { blocked: false, adsAllowed: false },
  },
  {
    name: 'getters absent entirely',
    googlefc: () => ({}),
    expected: { blocked: false, adsAllowed: false },
  },
  {
    name: 'getters return values from no known enum',
    googlefc: () => ({
      AdBlockerStatusEnum: FULL_STATUS_ENUM,
      AllowAdsStatusEnum: FULL_ALLOW_ENUM,
      getAdBlockerStatus: () => 'SOMETHING_NEW',
      getAllowAdsStatus: () => 'SOMETHING_NEW',
    }),
    expected: { blocked: false, adsAllowed: false },
  },
  {
    name: 'getters return null',
    googlefc: () => ({
      AdBlockerStatusEnum: FULL_STATUS_ENUM,
      AllowAdsStatusEnum: FULL_ALLOW_ENUM,
      getAdBlockerStatus: () => null,
      getAllowAdsStatus: () => null,
    }),
    expected: { blocked: false, adsAllowed: false },
  },
  {
    name: 'a getter throws',
    googlefc: () => ({
      AdBlockerStatusEnum: FULL_STATUS_ENUM,
      AllowAdsStatusEnum: FULL_ALLOW_ENUM,
      getAdBlockerStatus: () => {
        throw new Error('FC exploded');
      },
      getAllowAdsStatus: () => FULL_ALLOW_ENUM.ADS_ALLOWED,
    }),
    expected: 'no-payload',
  },
];

const COPIES: Array<[string, string]> = [
  ['shared loader (every static page)', FC_ADBLOCK_BRIDGE_JS],
  ['index.html (SPA entry)', extractIndexHtmlBridge()],
];

describe('AD_BLOCK_DATA_READY bridge — both copies are present', () => {
  it('ships in the shared loader every static page loads', () => {
    expect(ADSENSE_LOADER_CONTENT).toContain(FC_ADBLOCK_BRIDGE_JS);
  });

  it('ships in index.html too, for the SPA entry', () => {
    expect(indexHtml).toContain('__ftFcAdBlockBridge');
    expect(indexHtml).toContain('AD_BLOCK_DATA_READY');
  });

  it('the client reads the flag and the payload both copies publish', () => {
    // services/adBlockDetection.ts refuses to wait unless this flag is set, so
    // a bridge that stopped setting it would silently downgrade every visitor
    // to the local probe with nothing failing.
    expect(detection).toContain('__ftFcAdBlockBridge');
    expect(detection).toContain('__ftAdBlock');
  });

  it('all three agree on the event name', () => {
    expect(FC_ADBLOCK_SIGNAL_EVENT).toBe('frontaliere:adblock-data');
    expect(indexHtml).toContain(FC_ADBLOCK_SIGNAL_EVENT);
    expect(detection).toContain(FC_ADBLOCK_SIGNAL_EVENT);
    expect(ADSENSE_LOADER_CONTENT).toContain(FC_ADBLOCK_SIGNAL_EVENT);
  });

  it('stays idempotent, so two copies on one page cannot double-register', () => {
    for (const [where, src] of COPIES) {
      const googlefc: Record<string, unknown> = {
        AdBlockerStatusEnum: FULL_STATUS_ENUM,
        AllowAdsStatusEnum: FULL_ALLOW_ENUM,
        getAdBlockerStatus: () => FULL_STATUS_ENUM.NO_AD_BLOCKER,
        getAllowAdsStatus: () => FULL_ALLOW_ENUM.ADS_NOT_ALLOWED,
      };
      const win: Record<string, unknown> = { googlefc, dispatchEvent: () => true };
      const FakeCustomEvent = function FakeCustomEvent() {};
      // eslint-disable-next-line no-new-func
      const fn = new Function('window', 'CustomEvent', src) as (w: unknown, c: unknown) => void;
      fn(win, FakeCustomEvent);
      fn(win, FakeCustomEvent);
      const queue = (win.googlefc as { callbackQueue: unknown[] }).callbackQueue;
      expect(queue.length, `${where} registered twice`).toBe(1);
    }
  });
});

describe.each(COPIES)('AD_BLOCK_DATA_READY bridge — %s behaviour', (where, src) => {
  for (const scenario of [...SCENARIOS, ...DEGENERATE]) {
    it(`${scenario.name}`, () => {
      const result = runBridge(src, scenario.googlefc());
      if (scenario.expected === 'no-payload') {
        expect(result.noPayload, `${where} should have stashed nothing`).toBe(true);
        return;
      }
      expect(
        { blocked: result.blocked, adsAllowed: result.adsAllowed },
        `${where}: ${scenario.name}`,
      ).toEqual(scenario.expected);
      expect(result.events, 'the bridge must announce the payload exactly once').toBe(1);
    });
  }
});

describe('AD_BLOCK_DATA_READY bridge — the two copies answer identically', () => {
  const [[, loaderSrc], [, htmlSrc]] = COPIES;

  for (const scenario of [...SCENARIOS, ...DEGENERATE]) {
    it(`agree on: ${scenario.name}`, () => {
      const fromLoader = runBridge(loaderSrc, scenario.googlefc());
      const fromHtml = runBridge(htmlSrc, scenario.googlefc());
      expect(fromLoader).toEqual(fromHtml);
    });
  }

  it('never answers "blocked" and "allowlisted" together on degenerate FC state', () => {
    // The single combination that is worse than either half alone, and the one
    // a bare `===` produces from an undefined status plus a missing enum
    // member. It is unreachable ONLY through eq()-style comparison, so this
    // assertion is what pins the guard in place in both copies.
    for (const [where, src] of COPIES) {
      for (const scenario of DEGENERATE) {
        const r = runBridge(src, scenario.googlefc());
        expect(
          r.blocked === true && r.adsAllowed === true,
          `${where}: ${scenario.name} produced {blocked:true, adsAllowed:true}`,
        ).toBe(false);
      }
    }
  });
});
