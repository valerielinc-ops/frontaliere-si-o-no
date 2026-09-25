/**
 * The population of email senders in this repo, derived from disk.
 *
 * `sendEmailCascade` is the only way mail leaves here (every provider client
 * sits behind scripts/lib/email-cascade.mjs), so importing it is what makes a
 * script a sender — a definition that cannot go stale the way a hand-kept array
 * does.
 *
 * It lives in ONE file because more than one invariant is asserted over that
 * population — today `tests/no-channel-mails-unconfirmed.test.ts` (did this
 * address ever opt IN) and `tests/no-channel-mails-opted-out.test.ts` (has it
 * since opted OUT) — and each of those files works by requiring an explicit
 * verdict for every sender it finds. Two private copies of the discovery would
 * be two populations: a new channel could satisfy one file's exhaustiveness
 * check and be invisible to the other's, which is the failure mode both files
 * exist to prevent.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Read a repo-relative file as text. */
export const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Comments are where these invariants are DISCUSSED — the gates' own docblocks
 * name every sender — so a scan that did not strip them would pass on a file
 * that only talks about a gate without calling it.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every top-level `scripts/*.mjs` that puts mail on the wire. */
export function discoverSenders(): string[] {
  return readdirSync(path.join(ROOT, 'scripts'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => `scripts/${e.name}`)
    .filter((rel) => /sendEmailCascade/.test(stripComments(read(rel))));
}
