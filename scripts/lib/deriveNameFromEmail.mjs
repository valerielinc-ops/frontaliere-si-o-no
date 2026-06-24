/**
 * deriveNameFromEmail — best-effort first name from an email local-part, validated
 * against an OPEN-SOURCE first-names dataset (so we never greet "cool.dude@" as
 * "Cool"). Node-only: the ~19.9k-name dataset must NOT reach the browser bundle,
 * so this lives in scripts/lib (consumed by send-newsletter) rather than in
 * services/newsletter-template.mjs (which is bundled into the SPA via AdminPanel).
 *
 * Dataset: smashew/NameDatabases (`first names/all.txt`), The Unlicense
 * (public domain) — normalized to lowercase + de-accented in first-names.json.
 *
 * Reliability = precision over recall: a wrong name is worse than the generic
 * greeting. The candidate (first local-part token) must be a recognized first
 * name in the dataset AND pass sanitizeFirstName. Role/relay local-parts
 * (info/newsletter/no-reply/…) never match (they aren't names) and are also
 * stop-listed for clarity.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sanitizeFirstName } from '../../services/newsletter-template.mjs';

const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'first-names.json');
const FIRST_NAMES = new Set(JSON.parse(readFileSync(DATA_PATH, 'utf8')));

// Role/relay accounts — never a person. (Belt & suspenders: these aren't in the
// first-names dataset anyway, so they'd be rejected regardless.)
const ROLE_LOCALPARTS = new Set([
  'info', 'admin', 'administrator', 'sales', 'contact', 'contatti', 'hello', 'hi',
  'ciao', 'newsletter', 'news', 'support', 'help', 'team', 'mail', 'email', 'post',
  'noreply', 'no-reply', 'donotreply', 'office', 'ufficio', 'job', 'jobs', 'lavoro',
  'hr', 'marketing', 'press', 'privacy', 'billing', 'account', 'accounts', 'me',
  'test', 'demo', 'user', 'webmaster', 'postmaster', 'abuse', 'service', 'services',
]);

function deaccent(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * @param {unknown} email
 * @returns {string|null} a title-cased first name, or null when not derivable
 */
export function deriveNameFromEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return null;
  const local = email.split('@')[0].toLowerCase().trim();
  if (ROLE_LOCALPARTS.has(local)) return null;
  // firstname<sep>lastname or a bare firstname — take the first token.
  const first = local.split(/[._+\-]+/).filter(Boolean)[0] || '';
  if (!first || ROLE_LOCALPARTS.has(first)) return null;
  if (!FIRST_NAMES.has(deaccent(first))) return null; // must be a real first name
  return sanitizeFirstName(first); // validity + title-case display form
}
