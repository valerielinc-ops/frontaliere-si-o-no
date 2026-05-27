/**
 * Static scan: no internal <a> link may carry rel="nofollow".
 *
 * Semrush audit fix (732 nofollows on internal links). Internal links with
 * nofollow waste internal link equity — Google no longer fully ignores them
 * (they can still count against the source page) and there is no reason to
 * prevent crawl of same-domain pages.
 *
 * Allowed:
 *   - External links (absolute http(s) URL not pointing to frontaliereticino.ch)
 *     may carry rel="nofollow" or rel="nofollow sponsored" / "nofollow ugc".
 *   - rel="sponsored" alone (no "nofollow") on internal affiliate redirects is
 *     fine — this test only checks the nofollow token.
 *   - `<meta name="robots" content="... nofollow">` is unrelated — this test
 *     ignores anything that is not an `<a>` tag.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = [
  path.join(ROOT, 'components'),
  path.join(ROOT, 'services'),
  path.join(ROOT, 'build-plugins'),
];

// Files explicitly excluded:
//   - Third-party embed snippets where we let foreign sites paste attribution
//     HTML pointing back to us; using nofollow avoids pagerank dilution from
//     low-authority re-embedders (author-chosen).
//   - Test fixtures that simulate external ATS HTML.
const EXCLUDED_FILES = new Set<string>([
  path.join(ROOT, 'build-plugins', 'marketReportPlugin.ts'), // embed snippet for 3rd-party sites
  path.join(ROOT, 'build-plugins', 'borderWaitPagesPlugin.ts'), // webcam hotlink attribution
  path.join(ROOT, 'build-plugins', 'borderWaitMapPlugin.ts'), // widget-embed attribution copy
]);

function walk(dir: string, out: string[] = []): string[] {
  try {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full, out);
      else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
    }
  } catch {
    // dir does not exist — skip
  }
  return out;
}

/** True if `href` is an internal path (starts with "/" and not "//"). */
function isInternalHref(href: string): boolean {
  if (!href) return false;
  // Absolute to our canonical domain counts as internal.
  if (/^https?:\/\/(www\.)?frontaliereticino\.ch(\/|$)/.test(href)) return true;
  // Any relative path starting with "/" (but not protocol-relative "//").
  if (href.startsWith('/') && !href.startsWith('//')) return true;
  return false;
}

interface Violation { file: string; line: number; snippet: string; }

function findInternalNofollowAnchors(src: string): Array<{ line: number; snippet: string }> {
  const out: Array<{ line: number; snippet: string }> = [];
  const anchorRegex = /<a\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(src)) !== null) {
    const attrs = match[1];
    // Extract href (supports href="…" and href={…}).
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|\{([^}]+)\})/.exec(attrs);
    if (!hrefMatch) continue;
    const href = (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '').trim();

    // Extract rel attribute (both "…" string and {…} expression).
    const relMatch = /\brel\s*=\s*(?:"([^"]+)"|'([^']+)'|\{([^}]+)\})/.exec(attrs);
    if (!relMatch) continue;
    const relRaw = relMatch[1] ?? relMatch[2] ?? relMatch[3] ?? '';
    if (!/\bnofollow\b/.test(relRaw)) continue;

    if (!isInternalHref(href)) continue;

    const line = src.slice(0, match.index).split('\n').length;
    out.push({ line, snippet: match[0].slice(0, 160) });
  }
  return out;
}

describe('no rel="nofollow" on internal links', () => {
  it('scans components/, services/, build-plugins/ for internal anchors with nofollow', () => {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) walk(dir, files);

    const violations: Violation[] = [];
    for (const file of files) {
      if (EXCLUDED_FILES.has(file)) continue;
      const src = readFileSync(file, 'utf8');
      const bad = findInternalNofollowAnchors(src);
      for (const b of bad) violations.push({ file: path.relative(ROOT, file), ...b });
    }

    if (violations.length > 0) {
      const msg = violations
        .map((v) => `  ${v.file}:${v.line} → ${v.snippet}`)
        .join('\n');
      throw new Error(`Internal <a> elements carrying rel="nofollow":\n${msg}`);
    }
    expect(violations).toHaveLength(0);
  });
});
