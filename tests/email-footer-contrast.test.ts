// #5714 item 1 (follow-up of #5707, review of #5697) — "the same low-contrast
// pattern this PR fixes in the bulletin recurs in the identity/footer lines
// of winbackEmail.mjs, dormantWinbackStage1Email.mjs, publisherBlastEmail.mjs
// and send-job-alerts.mjs's unsubAllUrl."
//
// This test reads the SOURCE of those four files as text and checks the
// contrast of the actual `color:` declaration on each identity/unsubscribe
// line against the actual background it renders on — not a hardcoded
// assumption about which hex is "the fix". A file that swaps back to a
// literal low-contrast hex, or points a line at the wrong palette constant,
// fails here.
//
// It works from source text rather than importing the email builders because
// scripts/send-job-alerts.mjs pulls in services/jobAlertMatching.mjs →
// services/provinceCantonAffinity.ts → data/municipalities.ts at module
// scope — untracked in a sparse `packages/articles`-style worktree
// (CLAUDE.md "Worktree a disco pieno"). Reading the four files as text keeps
// this test green there AND in CI, and it is what
// tests/build-plugins/borderWaitContrast.test.ts already does for the same
// reason.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const AA_NORMAL_TEXT = 4.5; // WCAG AA, text below 18px / 14px-bold

function relLum([r, g, b]: [number, number, number]): number {
  const f = (c: number) => { const n = c / 255; return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); };
  const [rl, gl, bl] = [f(r), f(g), f(b)];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function contrastRatio(hexFg: string, hexBg: string): number {
  const l1 = relLum(hexToRgb(hexFg)) + 0.05;
  const l2 = relLum(hexToRgb(hexBg)) + 0.05;
  return l1 > l2 ? l1 / l2 : l2 / l1;
}

/** `const NAME = '#hex';` declarations in a file, name → hex. */
function parseColorConstants(source: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of source.matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'(#[0-9a-fA-F]{3,6})'/g)) {
    map[m[1]] = m[2];
  }
  return map;
}

/** Resolves a `${CONST}` token or a literal hex against a constants map. */
function resolveColor(token: string, consts: Record<string, string>): string {
  const ref = token.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (ref) {
    const hex = consts[ref[1]];
    if (!hex) throw new Error(`Unresolved color constant: ${ref[1]} (known: ${Object.keys(consts).join(', ')})`);
    return hex;
  }
  if (/^#[0-9a-fA-F]{3,6}$/.test(token)) return token;
  throw new Error(`Cannot resolve color token: ${token}`);
}

/**
 * The `color:` value on the ONE line of `source` containing `needle`. Throws
 * if the line is missing, ambiguous (needle on >1 line), or carries no
 * `color:` declaration — a strict anchor keeps this test honest about which
 * exact line it is grading.
 */
function colorOnLineContaining(source: string, needle: string): string {
  const lines = source.split('\n').filter((l) => l.includes(needle));
  if (lines.length === 0) throw new Error(`No line contains: ${needle}`);
  if (lines.length > 1) throw new Error(`Ambiguous anchor, ${lines.length} lines contain: ${needle}`);
  const m = lines[0].match(/color:(\$\{[A-Za-z_][A-Za-z0-9_]*\}|#[0-9a-fA-F]{3,6})/);
  if (!m) throw new Error(`No color: declaration on the line containing: ${needle}`);
  return m[1];
}


const ROOT = path.resolve(__dirname, '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('winbackEmail.mjs / dormantWinbackStage1Email.mjs — identity footer on PAGE_BG', () => {
  const PAGE_BG = '#f1f5f9';

  it.each([
    ['services/winbackEmail.mjs', '>Frontaliere Ticino · frontaliereticino.ch</div>'],
    ['services/winbackEmail.mjs', 'dataControllerFooterLine(l)}</div>'],
    ['services/dormantWinbackStage1Email.mjs', '>Frontaliere Ticino · frontaliereticino.ch</div>'],
    ['services/dormantWinbackStage1Email.mjs', 'dataControllerFooterLine(l))}</div>'],
  ])('%s identity line (%s) clears AA on PAGE_BG', (file, needle) => {
    const source = readSrc(file);
    const consts = parseColorConstants(source);
    const hex = resolveColor(colorOnLineContaining(source, needle), consts);
    expect(contrastRatio(hex, PAGE_BG)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe('publisherBlastEmail.mjs — dark footer lines on BRAND_DARK', () => {
  const source = readSrc('services/publisherBlastEmail.mjs');
  const consts = parseColorConstants(source);
  const BRAND_DARK = consts.BRAND_DARK;

  it.each([
    's.why(recipientEmail)',
    'esc(s.adsNote)',
    'href="${esc(unsubscribeUrl)}"',
    'dataControllerFooterLine(loc)',
  ])('line containing %j clears AA on BRAND_DARK', (needle) => {
    const hex = resolveColor(colorOnLineContaining(source, needle), consts);
    expect(contrastRatio(hex, BRAND_DARK)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe('send-job-alerts.mjs — dark footer lines (unsubAllUrl and its neighbours) on BRAND_DARK', () => {
  // buildAlertEmail()'s color constants are declared inside the function body
  // (not module scope, unlike the other three files) — parseColorConstants
  // still finds them since it scans the whole file text, not an AST scope.
  const source = readSrc('scripts/send-job-alerts.mjs');
  const consts = parseColorConstants(source);
  const BRAND_DARK = consts.BRAND_DARK;

  it.each([
    'margin:0 0 14px;line-height:1.5;', // wraps s.intendedFor(...) on the next line
    'text-decoration:underline;font-weight:600;',
    's.unsubThis(filterLabel)',
    'href="${unsubAllUrl}" style=',
    '0% spam, 100% frontaliere',
    'escHtml(dataControllerFooterLine(locale))',
  ])('line containing %j clears AA on BRAND_DARK', (needle) => {
    const hex = resolveColor(colorOnLineContaining(source, needle), consts);
    expect(contrastRatio(hex, BRAND_DARK)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('the unsubAllUrl anchor itself (the line the review named) clears AA', () => {
    const hex = resolveColor(colorOnLineContaining(source, 'href="${unsubAllUrl}" style='), consts);
    expect(contrastRatio(hex, BRAND_DARK)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe('sanity: the helper itself agrees with the well-known WCAG example pairs', () => {
  it('white on black is 21:1, black on white is 21:1', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
  });

  it('catches the ORIGINAL bug: raw #94a3b8 on the bulletin light background fails AA', () => {
    // services/daily-brief-template.mjs's own commit message measured this at
    // ~1.9:1 (a slightly different light bg than PAGE_BG here); either way it
    // is nowhere near 4.5.
    expect(contrastRatio('#94a3b8', '#f1f5f9')).toBeLessThan(AA_NORMAL_TEXT);
  });

  it('catches the SECOND bug this PR found: #475569 on BRAND_DARK fails AA even harder than MUTED did', () => {
    expect(contrastRatio('#475569', '#0f172a')).toBeLessThan(AA_NORMAL_TEXT);
  });
});
