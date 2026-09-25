import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RC_TO_ENV } from '../scripts/load-rc-env.mjs';

/**
 * Structural coverage check for #5737.
 *
 * `scripts/load-rc-env.mjs` is the ONLY Remote Config → process.env bridge
 * (see its own header comment). A Remote Config parameter that some code
 * path expects but that is absent from its `RC_TO_ENV` map stays `undefined`
 * for whoever reads it from `process.env`, no matter what is set in Remote
 * Config itself — and nothing fails loudly when that happens; the symptom is
 * silent (a feature that behaves as if permanently unconfigured). That is
 * exactly what happened to `NEWSLETTER_AC_SCHEME` / `NEWSLETTER_AC_TTL_DAYS` /
 * `NEWSLETTER_AC_LEGACY_SUNSET` before #5719 mapped them.
 *
 * `functions/src/remoteConfigSecrets.js` is the "verifier" side: Cloud
 * Functions read Remote Config directly there via `getRemoteConfigValue()`,
 * without going through `RC_TO_ENV` at all (they don't need to — the Admin
 * SDK talks to Remote Config directly). Most of its RC params have NO
 * `RC_TO_ENV` counterpart, and that is correct: they are server-only reads,
 * never needed by a `scripts/` sender or by CI. But a handful of RC params
 * are read on BOTH sides — a Cloud Function verifies what a `scripts/` sender
 * minted, or `functions/src/emailCascade.js` needs the same provider
 * credentials the scripts/ cascade already gets via this bridge — and for
 * those the file says so explicitly, in a comment naming
 * "scripts/load-rc-env.mjs" / "RC_TO_ENV". That phrase is this codebase's own
 * chosen signal for "this param must also be in RC_TO_ENV", used already for
 * three independent families (the autologin `ac` policy, the `token` policy,
 * and the email-provider cascade) — so scanning for it, instead of hardcoding
 * three names, is what makes this test catch the NEXT forgotten parameter
 * too, not just re-verify today's three.
 *
 * Extraction is a lightweight comment→code-span parser, not a plain source
 * regex: only RC keys physically inside a comment-tagged span (JSDoc above a
 * function, or a `//` block above a const) count, so an unrelated
 * `getRemoteConfigValue('X')` call elsewhere in the file — the majority of
 * them, which have no load-rc-env.mjs comment — is never swept in.
 */

const REMOTE_CONFIG_SECRETS_PATH = path.resolve(
  __dirname,
  '..',
  'functions',
  'src',
  'remoteConfigSecrets.js',
);

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

/**
 * Walk the source line by line. Whenever a comment region is found, check
 * whether it mentions "load-rc-env.mjs". If it does, capture the code span
 * immediately following it (via brace/bracket counting, so it stops at the
 * end of the function body or array literal it documents) and pull out every
 * RC key referenced there — either as a `getRemoteConfigValue('KEY')`
 * argument, or as a bare quoted UPPER_SNAKE_CASE string inside an array
 * literal (the `EMAIL_CASCADE_RC_KEYS` shape).
 */
function extractDualReadRcKeys(source: string): Set<string> {
  const lines = source.split('\n');
  const keys = new Set<string>();
  let i = 0;

  while (i < lines.length) {
    if (!isCommentLine(lines[i])) {
      i++;
      continue;
    }

    let commentText = '';
    while (i < lines.length) {
      if (isCommentLine(lines[i])) {
        commentText += lines[i] + '\n';
        i++;
        continue;
      }
      if (lines[i].trim() === '') {
        // A blank line ends the comment region unless another comment line
        // follows immediately after it (rare in this file, but don't let a
        // stray blank inside a comment block truncate it early).
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && isCommentLine(lines[j])) {
          i = j;
          continue;
        }
      }
      break;
    }

    if (!commentText.includes('load-rc-env.mjs')) continue;

    // Capture the code span the comment documents, via brace/bracket
    // balance, starting at the first `{` or `[` after the comment.
    let code = '';
    let depth = 0;
    let started = false;
    for (; i < lines.length; i++) {
      code += lines[i] + '\n';
      for (const ch of lines[i]) {
        if (ch === '{' || ch === '[') {
          depth++;
          started = true;
        }
        if (ch === '}' || ch === ']') depth--;
      }
      if (started && depth <= 0) {
        i++;
        break;
      }
    }

    for (const m of code.matchAll(/getRemoteConfigValue\(\s*'([A-Z0-9_]+)'\s*\)/g)) {
      keys.add(m[1]);
    }
    // Bare-array form (EMAIL_CASCADE_RC_KEYS): only treat quoted
    // UPPER_SNAKE_CASE strings as RC keys when the span is an array literal
    // assignment, so this doesn't also vacuum up unrelated string literals.
    if (/=\s*\[/.test(code)) {
      for (const m of code.matchAll(/'([A-Z0-9_]+)'/g)) {
        keys.add(m[1]);
      }
    }
  }

  return keys;
}

describe('RC_TO_ENV covers every dual-read Remote Config param (#5737)', () => {
  const source = fs.readFileSync(REMOTE_CONFIG_SECRETS_PATH, 'utf8');
  const dualReadKeys = extractDualReadRcKeys(source);

  it('extraction itself is not vacuous', () => {
    // Guards the guard: if remoteConfigSecrets.js's comment convention ever
    // changes shape and the parser above stops matching anything, this test
    // must fail LOUDLY instead of passing empty and silently checking
    // nothing. Today there are 16 dual-read keys across three families
    // (autologin `ac`, `token` policy, email-provider cascade); the floor
    // below is set well under that so unrelated future edits don't make this
    // assertion flaky, while still catching a parser that broke completely.
    expect(dualReadKeys.size).toBeGreaterThanOrEqual(10);
  });

  it('includes the #5737 autologin `ac` policy params', () => {
    expect([...dualReadKeys]).toEqual(
      expect.arrayContaining([
        'NEWSLETTER_AC_SCHEME',
        'NEWSLETTER_AC_TTL_DAYS',
        'NEWSLETTER_AC_LEGACY_SUNSET',
      ]),
    );
  });

  it('every dual-read RC param has an RC_TO_ENV entry', () => {
    const missing = [...dualReadKeys].filter((key) => !(key in RC_TO_ENV));
    expect(
      missing,
      `RC param(s) read by functions/src/remoteConfigSecrets.js as dual-read ` +
        `(scripts/load-rc-env.mjs bridges them too, per its own comments) but ` +
        `absent from RC_TO_ENV: ${missing.join(', ')}. Absent from that map, ` +
        `they stay \`undefined\` in process.env no matter what Remote Config ` +
        `holds — add them to RC_TO_ENV in scripts/load-rc-env.mjs.`,
    ).toEqual([]);
  });
});
