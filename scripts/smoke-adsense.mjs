#!/usr/bin/env node
/**
 * scripts/smoke-adsense.mjs — AdSense regression smoke checks
 *
 * Verifies the invariants that prevent the known AdSense failure modes:
 *   1. width=0 initialisation (ads pushed before container has measurable width)
 *   2. co-mounting of desktop + mobile placements in the same render (both
 *      visible via CSS rather than conditionally mounted in JS)
 *
 * Run locally:   node scripts/smoke-adsense.mjs
 * Run in CI:     added to validate-* step or post-build check
 *
 * Expected DOM behavior per placement:
 *
 *   ARTICLE_RAIL_RIGHT        desktop only  — rendered inside `isDesktopLg` block
 *   ARTICLE_INLINE_MOBILE     mobile only   — rendered inside `!isDesktopLg` or `isMobile` block
 *   ARTICLE_END_MULTIPLEX     all devices   — single placement at end of article
 *   JOBLIST_INFEED_DESKTOP    desktop only  — rendered when `!isMobile`
 *   JOBLIST_INFEED_MOBILE     mobile only   — rendered when `isMobile`
 *   JOBDETAIL_SIDEBAR         desktop only  — rendered inside `isDesktopLg` block
 *   JOBDETAIL_END_MULTIPLEX   all devices   — single placement at end of job detail
 *   JOBDETAIL_AUTH_GATE       all devices   — below sign-in form on auth gate
 *   AUTHGATE_RAIL_LEFT        desktop xl    — left sticky rail on auth gate
 *   AUTHGATE_RAIL_RIGHT       desktop xl    — right sticky rail on auth gate
 *   AUTHGATE_END_MULTIPLEX    all devices   — multiplex below auth gate 3-col layout
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ── Expected constants ─────────────────────────────────────────────── */

const EXPECTED_CLIENT_ID = 'ca-pub-8628054934855353';

const EXPECTED_SLOTS = {
  ARTICLE_RAIL_RIGHT:       '9739778973',
  ARTICLE_INLINE_MOBILE:    '1982411173',
  ARTICLE_END_MULTIPLEX:    '5196931137',
  JOBLIST_INFEED_DESKTOP:   '9770600968',
  JOBLIST_INFEED_MOBILE:    '6979586981',
  JOBDETAIL_SIDEBAR:        '8164676143',
  JOBDETAIL_END_MULTIPLEX:  '3205192616',
  JOBDETAIL_AUTH_GATE:      '3205029282',
  AUTHGATE_RAIL_LEFT:       '2190721703',
  AUTHGATE_RAIL_RIGHT:      '7139796055',
  AUTHGATE_END_MULTIPLEX:   '5826714385',
};

/** Placements that must be mounted mutually exclusive (desktop XOR mobile). */
const MUTUALLY_EXCLUSIVE_PAIRS = [
  {
    desktop:      'JOBLIST_INFEED_DESKTOP',
    mobile:       'JOBLIST_INFEED_MOBILE',
    file:         'components/community/JobBoard.tsx',
    desktopToken: 'AD_SLOTS.JOBLIST_INFEED_DESKTOP',
    mobileToken:  'AD_SLOTS.JOBLIST_INFEED_MOBILE',
    desktopGuard: '!isMobile',
    mobileGuard:  'isMobile',
  },
  {
    desktop:      'ARTICLE_RAIL_RIGHT',
    mobile:       'ARTICLE_INLINE_MOBILE',
    file:         'components/community/BlogArticles.tsx',
    desktopToken: 'AD_SLOTS.ARTICLE_RAIL_RIGHT',
    mobileToken:  'AD_SLOTS.ARTICLE_INLINE_MOBILE',
    desktopGuard: 'isDesktop',  // matches isDesktopLg, isDesktopXl, etc.
    mobileGuard:  'isMobile',
  },
];

const ADSENSE_BANNER_PATH  = path.join(ROOT, 'components', 'shared', 'AdSenseBanner.tsx');
const ADSENSE_SLOTS_PATH   = path.join(ROOT, 'services', 'adsenseSlots.ts');

/* ── Utility ────────────────────────────────────────────────────────── */

let errors = 0;
let warnings = 0;

function pass(msg) {
  console.log(`  ✅ ${msg}`);
}

function fail(msg) {
  console.error(`  ❌ FAIL: ${msg}`);
  errors++;
}

function warn(msg) {
  console.warn(`  ⚠️  WARN: ${msg}`);
  warnings++;
}

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function globTs(dir) {
  const results = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(tsx?|mts)$/.test(entry.name)) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

/* ── Check 1: CLIENT_ID matches expected ────────────────────────────── */

function checkClientId() {
  console.log('\n📋 Check 1: AdSense client ID');
  const slotsContent = readFile(ADSENSE_SLOTS_PATH);
  if (slotsContent.includes(EXPECTED_CLIENT_ID)) {
    pass(`Client ID ${EXPECTED_CLIENT_ID} found in adsenseSlots.ts`);
  } else {
    fail(`Expected client ID ${EXPECTED_CLIENT_ID} not found in adsenseSlots.ts`);
  }

  const bannerContent = readFile(ADSENSE_BANNER_PATH);
  if (bannerContent.includes(EXPECTED_CLIENT_ID)) {
    pass(`Client ID ${EXPECTED_CLIENT_ID} found in AdSenseBanner.tsx`);
  } else {
    fail(`Expected client ID ${EXPECTED_CLIENT_ID} not found in AdSenseBanner.tsx`);
  }
}

/* ── Check 2: All slot IDs present in adsenseSlots.ts ───────────────── */

function checkSlotIds() {
  console.log('\n📋 Check 2: Slot IDs in adsenseSlots.ts');
  const slotsContent = readFile(ADSENSE_SLOTS_PATH);
  for (const [name, slotId] of Object.entries(EXPECTED_SLOTS)) {
    if (slotsContent.includes(slotId)) {
      pass(`${name}: ${slotId} ✓`);
    } else {
      fail(`${name}: slot ID ${slotId} missing from adsenseSlots.ts`);
    }
  }
}

/* ── Check 3: No raw AdSense script tags outside AdSenseBanner.tsx ──── */

function checkNoRawScriptTags() {
  console.log('\n📋 Check 3: No raw AdSense script tags outside AdSenseBanner.tsx');
  const tsFiles = globTs(ROOT);
  const SCRIPT_PATTERNS = [
    /pagead2\.googlesyndication\.com/,
    /<script[^>]+adsbygoogle[^>]*>/,
  ];

  let clean = true;
  for (const file of tsFiles) {
    const rel = path.relative(ROOT, file);
    if (rel === 'components/shared/AdSenseBanner.tsx') continue;
    const content = readFile(file);
    for (const pattern of SCRIPT_PATTERNS) {
      if (pattern.test(content)) {
        fail(`Raw AdSense script reference in ${rel} (pattern: ${pattern})`);
        clean = false;
      }
    }
  }
  if (clean) pass('No raw AdSense script tags found outside AdSenseBanner.tsx');
}

/* ── Check 4: adsbygoogle.push() only in AdSenseBanner.tsx ─────────── */

function checkNoDirectPush() {
  console.log('\n📋 Check 4: adsbygoogle.push() only in AdSenseBanner.tsx');
  const tsFiles = globTs(ROOT);
  let clean = true;
  for (const file of tsFiles) {
    const rel = path.relative(ROOT, file);
    if (rel === 'components/shared/AdSenseBanner.tsx') continue;
    const content = readFile(file);
    if (/adsbygoogle.*push\(/.test(content) || /\.push\(\s*\{\s*\}\s*\)/.test(content)) {
      // Only flag if it's paired with adsbygoogle context
      if (content.includes('adsbygoogle')) {
        fail(`Direct adsbygoogle.push() call in ${rel} — should only be in AdSenseBanner.tsx`);
        clean = false;
      }
    }
  }
  if (clean) pass('adsbygoogle.push() confined to AdSenseBanner.tsx');
}

/* ── Check 5: Mutually exclusive desktop/mobile pairs ───────────────── */

function checkMutuallyExclusivePairs() {
  console.log('\n📋 Check 5: Mutually exclusive desktop/mobile mounting');

  for (const { desktop, mobile, file, desktopToken, mobileToken, desktopGuard, mobileGuard } of MUTUALLY_EXCLUSIVE_PAIRS) {
    const filePath = path.join(ROOT, file);
    if (!fs.existsSync(filePath)) {
      warn(`${file} not found — cannot verify ${desktop}/${mobile} exclusivity`);
      continue;
    }

    const content = readFile(filePath);

    // Components reference slots via AD_SLOTS constants, not raw IDs.
    // Check for the constant name (e.g. AD_SLOTS.JOBLIST_INFEED_DESKTOP).
    if (!content.includes(desktopToken)) {
      fail(`${file}: desktop token ${desktopToken} (${desktop}) not found`);
      continue;
    }
    if (!content.includes(mobileToken)) {
      fail(`${file}: mobile token ${mobileToken} (${mobile}) not found`);
      continue;
    }

    // Look for a conditional guard within 600 chars before the token reference.
    const desktopIdx = content.indexOf(desktopToken);
    const mobileIdx  = content.indexOf(mobileToken);

    const desktopContext = content.slice(Math.max(0, desktopIdx - 600), desktopIdx);
    const mobileContext  = content.slice(Math.max(0, mobileIdx  - 600), mobileIdx);

    // Desktop guard: matches any "isDesktop*" variant or "!isMobile"
    const desktopGuardPresent = desktopContext.includes(desktopGuard)
      || desktopContext.includes('isDesktopLg')
      || desktopContext.includes('isDesktopXl')
      || desktopContext.includes('!isMobile');
    // Mobile guard: matches "isMobile" or "!isDesktop*"
    const mobileGuardPresent = mobileContext.includes(mobileGuard)
      || mobileContext.includes('isMobile')
      || mobileContext.includes('!isDesktopLg')
      || mobileContext.includes('!isDesktopXl');

    if (desktopGuardPresent) {
      pass(`${file}: ${desktop} is guarded by breakpoint condition`);
    } else {
      fail(`${file}: ${desktop} (${desktopToken}) does not appear to be inside a breakpoint guard — risk of co-mounting`);
    }

    if (mobileGuardPresent) {
      pass(`${file}: ${mobile} is guarded by breakpoint condition`);
    } else {
      warn(`${file}: ${mobile} (${mobileToken}) guard pattern not detected — verify manually`);
    }
  }
}

/* ── Check 6: useMediaQuery returns null on SSR (no window access) ──── */

function checkMediaQueryHook() {
  console.log('\n📋 Check 6: useMediaQuery hook SSR safety');
  const hookPath = path.join(ROOT, 'hooks', 'useMediaQuery.ts');
  const altPath  = path.join(ROOT, 'hooks', 'useMediaQuery.tsx');
  const filePath = fs.existsSync(hookPath) ? hookPath : altPath;

  if (!fs.existsSync(filePath)) {
    warn('useMediaQuery hook not found — cannot verify SSR safety');
    return;
  }

  const content = readFile(filePath);

  // Should be SSR-safe: either null literal initial state OR a lazy initializer
  // that guards with typeof window === 'undefined' (returns null on SSR).
  const hasNullLiteral = /useState[^(]*\(\s*null\s*\)/.test(content);
  const hasLazyInitWithNullGuard = /useState[^(]*\(\s*\(\s*\)\s*=>/.test(content) && content.includes('typeof window');
  if (hasNullLiteral || hasLazyInitWithNullGuard) {
    pass('useMediaQuery is SSR-safe (returns null on server, correct value on client)');
  } else if (/useState[^(]*\(\s*false\s*\)/.test(content)) {
    fail('useMediaQuery uses false as initial state — ads may mount on wrong breakpoint during hydration');
  } else {
    warn('useMediaQuery initial state pattern not detected — verify SSR safety manually');
  }

  // Should use useEffect for responding to media query changes
  if (content.includes('useEffect')) {
    pass('useMediaQuery uses useEffect for matchMedia change listener');
  } else {
    fail('useMediaQuery does not use useEffect — change events will not be handled');
  }
}

/* ── Check 7: AdSenseBanner width guard present ─────────────────────── */

function checkWidthGuard() {
  console.log('\n📋 Check 7: AdSenseBanner width-aware initialization');
  const content = readFile(ADSENSE_BANNER_PATH);

  if (content.includes('getBoundingClientRect') && content.includes('width > 0')) {
    pass('Width guard (getBoundingClientRect + width > 0) present in AdSenseBanner.tsx');
  } else if (content.includes('getBoundingClientRect')) {
    pass('getBoundingClientRect present — verify width > 0 check manually');
  } else {
    fail('Width guard missing in AdSenseBanner.tsx — ads may initialize with width=0');
  }

  if (content.includes('ResizeObserver')) {
    pass('ResizeObserver present for deferred width detection');
  } else {
    warn('ResizeObserver not found — ads may not recover from initially-zero-width containers');
  }
}

/* ── Main ───────────────────────────────────────────────────────────── */

console.log('═══════════════════════════════════════════════');
console.log('  AdSense Regression Smoke Checks');
console.log('═══════════════════════════════════════════════');

checkClientId();
checkSlotIds();
checkNoRawScriptTags();
checkNoDirectPush();
checkMutuallyExclusivePairs();
checkMediaQueryHook();
checkWidthGuard();

console.log('\n─────────────────────────────────────────────');
if (errors > 0) {
  console.error(`\n❌ ${errors} check(s) failed, ${warnings} warning(s).`);
  console.error('   Fix the failing checks before deploying AdSense changes.');
  process.exit(1);
} else if (warnings > 0) {
  console.warn(`\n✅ All checks passed with ${warnings} warning(s).`);
  console.warn('   Review warnings before deploying to production.');
} else {
  console.log('\n✅ All AdSense smoke checks passed.');
}
