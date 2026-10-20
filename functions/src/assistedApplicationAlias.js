/**
 * Per-order e-mail alias of the automated assisted application (owner
 * decision 2026-09-30: "alias ovunque"). The employer sees
 * `nome.cognome.xxxx@candidature.frontaliereticino.ch` (the candidate's name
 * and 4 random characters, so it reads as a person's address and still cannot
 * be guessed from the name alone) in portal forms and as the Reply-To of
 * e-mail applications; without a name, `c-<10 chars>@…` as before. The phone
 * number stays the candidate's.
 * Every employer message therefore reaches our Email Worker, which hands it
 * to assistedApplicationInbound.js: classified, stored, forwarded to the
 * candidate with Reply-To set to the recruiter.
 *
 * Cloudflare Email Routing has a catch-all only for the apex domain, and a
 * subdomain routes only literal addresses (developers.cloudflare.com
 * email-service/configuration/subdomains). So each alias gets its own
 * literal rule → worker, created when the flow starts and deleted by the
 * 90-day retention. The apex catch-all (human inbox) is never touched.
 */

import { randomBytes } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';

export const ALIAS_DOMAIN = 'candidature.frontaliereticino.ch';
export const ALIASES_COLLECTION = 'assisted_application_aliases';
import { EMAIL_WORKER_NAME } from './emailWorkerName.js';

export { EMAIL_WORKER_NAME };
const ZONE_NAME = 'frontaliereticino.ch';
const CF_API = 'https://api.cloudflare.com/client/v4';
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
// `c-xxxxxxxxxx` (no name) or `nome.cognome.xxxx`: up to four name parts,
// letters and inner hyphens, then 4 random characters. Mirrored in the Email
// Worker (infra/cloudflare-email-worker/stop-reply-handler.js, isAssistedAlias).
const LOCAL_PART_RE = /^(?:c-[a-z2-9]{10}|[a-z]+(?:-[a-z]+)*(?:\.[a-z]+(?:-[a-z]+)*){0,3}\.[a-z2-9]{4})$/;
const MAX_LOCAL_PART = 40;
const MAX_NAME_PART = 30;
const GERMAN_LETTERS = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** "Luigi D'Angelo-Müller" → "luigi.dangelo-mueller"; '' when no letter is left. */
export function aliasNamePart(name) {
  const parts = String(name || '')
    .toLowerCase()
    .replace(/[äöüß]/g, (letter) => GERMAN_LETTERS[letter])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`´]/g, '')
    .split(/[^a-z-]+/)
    .map((part) => part.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  if (!parts.length) return '';
  // First name and surname particles (de, van der…) up to four parts; a
  // longer name keeps its first and last part.
  let chosen = parts.length > 4 ? [parts[0], parts[parts.length - 1]] : parts;
  if (chosen.join('.').length > MAX_NAME_PART) chosen = [parts[0], parts[parts.length - 1]];
  const joined = chosen.join('.');
  return joined.length > MAX_NAME_PART ? joined.slice(0, MAX_NAME_PART).replace(/[.-]+$/, '') : joined;
}

function randomChars(bytes, count) {
  let out = '';
  for (const byte of bytes.subarray(0, count)) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export function newAliasLocalPart(bytes = randomBytes(10), name = '') {
  const namePart = aliasNamePart(name);
  if (namePart) return `${namePart}.${randomChars(bytes, 4)}`;
  return `c-${randomChars(bytes, 10)}`;
}

/** The local part when `address` is one of our aliases, else ''. */
export function aliasLocalPart(address) {
  const value = String(address || '').trim().toLowerCase();
  const [local, domain] = value.split('@');
  return domain === ALIAS_DOMAIN && String(local || '').length <= MAX_LOCAL_PART && LOCAL_PART_RE.test(local || '') ? local : '';
}

export function aliasAddress(localPart) {
  return `${localPart}@${ALIAS_DOMAIN}`;
}

/** Cloudflare Email Routing client (rules of the apex zone), Remote Config credentials. */
export function cloudflareEmailRouting({ fetchImpl = fetch, read = getRemoteConfigValue } = {}) {
  let zonePromise = null;
  const token = async () => {
    const value = String(await read('CF_API_TOKEN') || '').trim();
    if (!value) throw new Error('cf_token_missing');
    return value;
  };
  const call = async (path, init = {}) => {
    const response = await fetchImpl(`${CF_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.success === false) {
      throw new Error(`cf_${response.status}:${String(json.errors?.[0]?.message || '').slice(0, 120)}`);
    }
    return json.result;
  };
  const zoneId = async () => {
    zonePromise ||= (async () => {
      const configured = String(await read('CF_ZONE_ID') || '').trim();
      if (configured) return configured;
      const zones = await call(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
      if (!zones?.[0]?.id) throw new Error('cf_zone_not_found');
      return zones[0].id;
    })();
    return zonePromise;
  };
  return {
    async createRule(address, name) {
      const result = await call(`/zones/${await zoneId()}/email/routing/rules`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.slice(0, 100),
          enabled: true,
          matchers: [{ type: 'literal', field: 'to', value: address }],
          actions: [{ type: 'worker', value: [EMAIL_WORKER_NAME] }],
        }),
      });
      return result?.tag || result?.id || null;
    },
    async deleteRule(ruleId) {
      await call(`/zones/${await zoneId()}/email/routing/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
    },
  };
}

/**
 * Give the order its alias (idempotent). The alias is `active` only once its
 * routing rule exists: before that the runner keeps using the candidate's own
 * address, so no employer message can be lost.
 * @returns {Promise<{address:string, active:boolean}>}
 */
export async function ensureOrderAlias({ db, orderId, cf = cloudflareEmailRouting(), nowMs = Date.now() }) {
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId));
  const snapshot = await orderRef.get();
  const current = snapshot.data()?.candidateAlias;
  const candidateName = snapshot.data()?.applicantName || snapshot.data()?.customerName || '';
  if (current?.address && current.active) return { address: current.address, active: true };

  let localPart = aliasLocalPart(current?.address);
  if (!localPart) {
    for (let attempt = 0; attempt < 5 && !localPart; attempt += 1) {
      const candidate = newAliasLocalPart(randomBytes(10), candidateName);
      const aliasRef = db.collection(ALIASES_COLLECTION).doc(candidate);
      await db.runTransaction(async (transaction) => {
        localPart = null; // a retried transaction must not keep a candidate an earlier attempt picked
        const existing = await transaction.get(aliasRef);
        if (existing.exists) return;
        transaction.set(aliasRef, { orderId: String(orderId), createdAt: nowMs, ruleId: null });
        transaction.set(orderRef, { candidateAlias: { address: aliasAddress(candidate), active: false, createdAt: nowMs } }, { merge: true });
        localPart = candidate;
      });
    }
    if (!localPart) throw new Error('alias_collision');
  }
  const address = aliasAddress(localPart);
  try {
    const ruleId = await cf.createRule(address, `assisted-application ${orderId}`);
    await db.collection(ALIASES_COLLECTION).doc(localPart).set({ ruleId, activatedAt: nowMs }, { merge: true });
    await orderRef.set({ candidateAlias: { address, active: true, activatedAt: nowMs, updatedAt: FieldValue.serverTimestamp() } }, { merge: true });
    return { address, active: true };
  } catch (error) {
    console.error('[assistedApplicationAlias] routing rule not created', orderId, error instanceof Error ? error.message : String(error));
    return { address, active: false };
  }
}

export async function orderIdForAlias(db, address) {
  const localPart = aliasLocalPart(address);
  if (!localPart) return null;
  const snapshot = await db.collection(ALIASES_COLLECTION).doc(localPart).get();
  return snapshot.exists ? String(snapshot.data()?.orderId || '') || null : null;
}

/** Retention: remove the routing rule and the alias mapping. */
export async function removeOrderAlias({ db, order, cf = cloudflareEmailRouting() }) {
  const localPart = aliasLocalPart(order?.candidateAlias?.address);
  if (!localPart) return false;
  const aliasRef = db.collection(ALIASES_COLLECTION).doc(localPart);
  const snapshot = await aliasRef.get();
  const ruleId = snapshot.data()?.ruleId;
  if (ruleId) await cf.deleteRule(ruleId);
  await aliasRef.delete();
  return true;
}
