/**
 * Static scan: every icon-only anchor in components/ must expose an accessible name.
 *
 * Accessible name can come from:
 *   - aria-label / aria-labelledby on the <a>
 *   - a child <span className="sr-only">…</span>
 *   - a visible text child
 *   - a title attribute (last-resort, still counts)
 *
 * This guards against regressions of the Semrush "links without anchor text"
 * finding (≈870 links). It is a string-based check, not a render-time check —
 * rendering every component with 170+ modules is prohibitively slow.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const COMPONENTS_DIR = path.join(ROOT, 'components');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Find anchor elements whose *only* child content is an icon (JSX-tag starting
 * with a capital letter + self-closing, or an inline <svg>). If such an anchor
 * has no aria-label / aria-labelledby / title, it's a violation.
 */
function findIconOnlyAnchors(src: string): Array<{ match: string; line: number }> {
  const violations: Array<{ match: string; line: number }> = [];
  // Match <a ...>(whitespace)<Icon .../>(whitespace)</a> or <a ...><svg.../></svg></a>
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;

  while ((match = anchorRegex.exec(src)) !== null) {
    const [full, attrs, inner] = match;
    const trimmedInner = inner.trim();

    // Is the inner content "icon only"? (single self-closing capital-letter tag
    // or a <svg>...</svg> block with nothing else)
    const iconOnly =
      /^<[A-Z][A-Za-z0-9]*\s[^>]*\/>$/.test(trimmedInner) ||
      /^<[A-Z][A-Za-z0-9]*\s*\/>$/.test(trimmedInner) ||
      /^<svg[\s\S]*<\/svg>$/.test(trimmedInner);

    if (!iconOnly) continue;

    const hasAccessibleName =
      /\baria-label\s*=/.test(attrs) ||
      /\baria-labelledby\s*=/.test(attrs) ||
      /\btitle\s*=/.test(attrs) ||
      /sr-only/.test(inner);

    if (!hasAccessibleName) {
      const line = src.slice(0, match.index).split('\n').length;
      violations.push({ match: full.slice(0, 140), line });
    }
  }

  return violations;
}

describe('no icon-only anchors without an accessible name', () => {
  it('every <a> with only an icon child has aria-label / aria-labelledby / title / sr-only', () => {
    const files = walk(COMPONENTS_DIR);
    const allViolations: Array<{ file: string; line: number; match: string }> = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const violations = findIconOnlyAnchors(src);
      for (const v of violations) {
        allViolations.push({ file: path.relative(ROOT, file), ...v });
      }
    }

    if (allViolations.length > 0) {
      const msg = allViolations
        .map((v) => `  ${v.file}:${v.line} → ${v.match}`)
        .join('\n');
      throw new Error(`Icon-only anchors missing an accessible name:\n${msg}`);
    }

    expect(allViolations).toHaveLength(0);
  });
});
