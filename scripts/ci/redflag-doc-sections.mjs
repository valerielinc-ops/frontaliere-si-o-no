/**
 * Extract the small, binding document sections needed by pr-redflag-fixer.
 *
 * This runs before Claude and fails closed: a renamed or removed heading must
 * stop the prefetch instead of producing a bundle that looks complete.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const REQUIRED_SECTIONS = Object.freeze([
  { file: 'REVIEW.md', heading: '## Scopo progetto = filtro "important"' },
  { file: 'REVIEW.md', heading: '## Severity' },
  { file: 'AGENTS.md', heading: '## Non-Negotiables' },
  { file: 'AGENTS.md', heading: '## Privacy' },
]);

function normalizeMarkdownHeading(line) {
  return line.replace(/^[ \t]{0,3}/, '').replace(/[ \t]+$/, '');
}

function headingLine(line) {
  return headingLevel(line) !== null;
}

function headingLevel(line) {
  const match = normalizeMarkdownHeading(line).match(/^(#{1,6})[ \t]+/);
  return match ? match[1].length : null;
}

function fenceMarker(line) {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  return match ? match[1][0] : null;
}

/**
 * Extract a Markdown section by its heading text, stopping at the next
 * heading of any level. Headings inside fenced code are ignored.
 *
 * @param {string} markdown
 * @param {string} heading exact heading, including its # prefix
 * @returns {string} section body without the heading
 */
export function extractSectionByHeading(markdown, heading) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const target = String(heading).trim();
  let inFence = null;
  const matches = [];

  for (let index = 0; index < lines.length; index += 1) {
    const marker = fenceMarker(lines[index]);
    if (marker) {
      inFence = inFence === marker ? null : inFence ?? marker;
      continue;
    }
    if (!inFence && normalizeMarkdownHeading(lines[index]) === target) matches.push(index);
  }

  if (inFence) {
    throw new Error(`Unclosed fenced code block while locating required heading: ${target}`);
  }
  if (matches.length === 0) {
    throw new Error(`Required heading not found: ${target}`);
  }
  if (matches.length > 1) {
    throw new Error(`Required heading is ambiguous (${matches.length} matches): ${target}`);
  }

  const start = matches[0];
  const targetLevel = headingLevel(lines[start]);
  inFence = null;
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const marker = fenceMarker(lines[index]);
    if (marker) {
      inFence = inFence === marker ? null : inFence ?? marker;
      body.push(lines[index]);
      continue;
    }
    const level = headingLine(lines[index]) ? headingLevel(lines[index]) : null;
    if (!inFence && level !== null && level <= targetLevel) break;
    body.push(lines[index]);
  }

  if (inFence) {
    throw new Error(`Unclosed fenced code block in required section: ${target}`);
  }
  const content = body.join('\n').trim();
  if (!content) {
    throw new Error(`Required heading has no content: ${target}`);
  }
  return content;
}

/**
 * Build the document fragment embedded in redflag-bundle.md.
 *
 * @param {{ read?: (file: string) => string }} [options]
 * @returns {string}
 */
export function buildRedflagDocumentSections({ read } = {}) {
  const reader = read ?? ((file) => readFileSync(resolve(process.env.REDFLAG_DOC_ROOT ?? '.', file), 'utf8'));
  const chunks = REQUIRED_SECTIONS.map(({ file, heading }) => {
    const content = extractSectionByHeading(reader(file), heading);
    const title = heading.replace(/^#{1,6}[ \t]+/, '');
    return [`## ${file} — ${title}`, content].join('\n\n');
  });

  return ['# Redflag-fix: sezioni documentali vincolanti', ...chunks].join('\n\n') + '\n';
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  try {
    process.stdout.write(buildRedflagDocumentSections());
  } catch (error) {
    console.error(`redflag-doc-sections: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
