/**
 * Dataset-backed first-name recognition for Node-side pipelines.
 *
 * This stays independent from `services/newsletter-template.mjs`: the article
 * factuality gate is an `identical` transport twin whose closure is registered
 * by the generator transport, while the newsletter template has a much larger
 * browser-facing dependency graph. Keeping the recognizer here lets both Node
 * consumers use the same high-precision rule without transporting that
 * unrelated graph into nanako.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'first-names.json');
const FIRST_NAMES = new Set(JSON.parse(readFileSync(DATA_PATH, 'utf8')));

// Role/relay accounts — never a person. These are also kept here rather than
// inferred from the first-name dataset so the rejection remains explicit.
const ROLE_LOCALPARTS = new Set([
  'info', 'admin', 'administrator', 'sales', 'contact', 'contatti', 'hello', 'hi',
  'ciao', 'newsletter', 'news', 'support', 'help', 'team', 'mail', 'email', 'post',
  'noreply', 'no-reply', 'donotreply', 'office', 'ufficio', 'job', 'jobs', 'lavoro',
  'hr', 'marketing', 'press', 'privacy', 'billing', 'account', 'accounts', 'me',
  'test', 'demo', 'user', 'webmaster', 'postmaster', 'abuse', 'service', 'services',
]);

function deaccent(value) {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function sanitizeRecognizedFirstName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const first = raw.trim().split(/\s+/)[0] || '';
  if (first.length < 2 || first.length > 30) return null;
  if (!/^[\p{L}][\p{L}'’-]*$/u.test(first)) return null;
  return first.toLowerCase().replace(/(^|[-'’])(\p{L})/gu, (_, separator, character) => (
    separator + character.toUpperCase()
  ));
}

/**
 * Return a title-cased first name only when the first token is in the
 * open-source first-name dataset and passes the same defensive sanitizer used
 * by the newsletter name flow. Precision is preferred over recall.
 *
 * @param {unknown} candidate
 * @returns {string|null}
 */
export function recognizeFirstName(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  const norm = candidate.toLowerCase().trim();
  if (!norm || ROLE_LOCALPARTS.has(norm)) return null;
  const first = norm.split(/[\s._+\-]+/).filter(Boolean)[0] || '';
  if (!first || ROLE_LOCALPARTS.has(first)) return null;
  if (!FIRST_NAMES.has(deaccent(first))) return null;
  return sanitizeRecognizedFirstName(first);
}
