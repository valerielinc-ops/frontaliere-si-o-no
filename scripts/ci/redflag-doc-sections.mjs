/**
 * Extract the small, binding document sections needed by automated fixers.
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

export const AGENTS_REQUIRED_SECTIONS = Object.freeze([
  { file: 'AGENTS.md', heading: '## Non-Negotiables' },
  { file: 'AGENTS.md', heading: '## Privacy' },
]);

// This exact marker is written by pr-redflag-fixer.yml to $GITHUB_ENV. A
// literal line equal to it would terminate the heredoc early and turn the
// remaining contract into unrelated environment-file records.
export const REDFLAG_DOC_SECTIONS_EOF = 'REDFLAG_DOC_SECTIONS_EOF';

// The value is interpolated into the action prompt after it leaves $GITHUB_ENV.
// Keep a bounded, UTF-8 byte-sized budget so growth fails closed before the
// runner or action silently truncates the contract.
export const REDFLAG_DOC_SECTIONS_MAX_BYTES = 16_384;

function normalizeMarkdownHeading(line) {
  return line.replace(/^[ \t]{0,3}/, '').replace(/[ \t]+$/, '');
}

function headingLevel(line) {
  const match = normalizeMarkdownHeading(line).match(/^(#{1,6})[ \t]+/);
  return match ? match[1].length : null;
}

function markdownHeadingAt(lines, index) {
  const line = lines[index];
  const level = headingLevel(line);
  if (level !== null) {
    return {
      level,
      text: normalizeMarkdownHeading(line).replace(/^#{1,6}[ \t]+/, '').trim(),
      bodyStart: index + 1,
    };
  }

  const text = normalizeMarkdownHeading(line).trim();
  const underline = index + 1 < lines.length
    && normalizeMarkdownHeading(lines[index + 1]).match(/^(=+|-+)[ \t]*$/);
  if (!text || !underline) return null;

  return {
    level: underline[1][0] === '=' ? 1 : 2,
    text,
    bodyStart: index + 2,
  };
}

function fenceMarker(line) {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  return match ? { char: match[1][0], length: match[1].length } : null;
}

function advanceFenceState(inFence, marker) {
  if (!inFence) return marker;
  return marker.char === inFence.char && marker.length >= inFence.length ? null : inFence;
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
  const targetLevel = headingLevel(target);
  const targetText = targetLevel === null
    ? target
    : normalizeMarkdownHeading(target).replace(/^#{1,6}[ \t]+/, '').trim();
  let inFence = null;
  const matches = [];

  for (let index = 0; index < lines.length; index += 1) {
    const marker = fenceMarker(lines[index]);
    if (marker) {
      inFence = advanceFenceState(inFence, marker);
      continue;
    }
    const headingAt = !inFence ? markdownHeadingAt(lines, index) : null;
    if (headingAt && headingAt.level === targetLevel && headingAt.text === targetText) {
      matches.push(headingAt);
    }
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

  const { level: matchedLevel, bodyStart } = matches[0];
  inFence = null;
  const body = [];
  for (let index = bodyStart; index < lines.length; index += 1) {
    const marker = fenceMarker(lines[index]);
    if (marker) {
      inFence = advanceFenceState(inFence, marker);
      body.push(lines[index]);
      continue;
    }
    const headingAt = !inFence ? markdownHeadingAt(lines, index) : null;
    if (!inFence && headingAt && headingAt.level <= matchedLevel) break;
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
 * Build the document fragment injected into an automated fixer's prompt.
 *
 * @param {{ read?: (file: string) => string }} [options]
 * @returns {string}
 */
function buildDocumentSections(requiredSections, title, { read } = {}) {
  const reader = read ?? ((file) => readFileSync(resolve(process.env.REDFLAG_DOC_ROOT ?? '.', file), 'utf8'));
  const chunks = requiredSections.map(({ file, heading }) => {
    const content = extractSectionByHeading(reader(file), heading);
    const title = heading.replace(/^#{1,6}[ \t]+/, '');
    return [`## ${file} — ${title}`, content].join('\n\n');
  });

  return [title, ...chunks].join('\n\n') + '\n';
}

export function buildRedflagDocumentSections({ read } = {}) {
  return validateRedflagDocumentSections(
    buildDocumentSections(REQUIRED_SECTIONS, '# Redflag-fix: sezioni documentali vincolanti', { read }),
  );
}

/**
 * Validate the exact value that pr-redflag-fixer.yml writes to $GITHUB_ENV.
 *
 * @param {string} document
 * @returns {string}
 */
export function validateRedflagDocumentSections(document) {
  const value = String(document);
  const hasDelimiterLine = value.split(/\r?\n/).some(
    (line) => line === REDFLAG_DOC_SECTIONS_EOF,
  );
  if (hasDelimiterLine) {
    throw new Error(
      `Redflag document contains a line equal to the heredoc delimiter ${REDFLAG_DOC_SECTIONS_EOF}`,
    );
  }

  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > REDFLAG_DOC_SECTIONS_MAX_BYTES) {
    throw new Error(
      `Redflag document too large for GITHUB_ENV: ${bytes} bytes > ${REDFLAG_DOC_SECTIONS_MAX_BYTES}-byte limit`,
    );
  }

  return value;
}

/**
 * Indent the document for the multiline GitHub Actions prompt and enforce the
 * byte budget on the value that is actually injected, not only on its raw
 * unindented form.
 *
 * @param {string} document
 * @param {string} [indent]
 * @returns {string}
 */
export function indentAndValidateRedflagDocumentSections(document, indent = '            ') {
  const value = validateRedflagDocumentSections(document);
  const indented = value.split(/\r?\n/).map((line) => indent + line).join('\n');
  const bytes = Buffer.byteLength(indented, 'utf8');
  if (bytes > REDFLAG_DOC_SECTIONS_MAX_BYTES) {
    throw new Error(
      `Indented redflag document too large for the prompt: ${bytes} bytes > ${REDFLAG_DOC_SECTIONS_MAX_BYTES}-byte limit`,
    );
  }
  return indented;
}

export function buildIssueFixAgentContract({ read } = {}) {
  return validateRedflagDocumentSections(
    buildDocumentSections(AGENTS_REQUIRED_SECTIONS, '# Issue-fix: contratto AGENTS.md vincolante', { read }),
  );
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  try {
    const builder = process.argv.includes('--agents-only')
      ? buildIssueFixAgentContract
      : buildRedflagDocumentSections;
    process.stdout.write(builder());
  } catch (error) {
    console.error(`redflag-doc-sections: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
