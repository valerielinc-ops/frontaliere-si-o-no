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
 * name in the dataset and pass the same defensive sanitizer. Role/relay local-parts
 * (info/newsletter/no-reply/…) never match (they aren't names) and are also
 * stop-listed for clarity.
 */
import { recognizeFirstName } from './first-name-recognition.mjs';

export { recognizeFirstName };
/**
 * @param {unknown} email
 * @returns {string|null} a title-cased first name, or null when not derivable
 */
export function deriveNameFromEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return null;
  return recognizeFirstName(email.split('@')[0]);
}
