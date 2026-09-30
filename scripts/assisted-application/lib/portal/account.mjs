/**
 * Portal accounts (fase 3c: Workday, SuccessFactors and every portal that
 * asks for a login). career-ops hands a login over to the person; the owner
 * decided instead (2026-09-30) that the runner creates the account itself on
 * the order's alias (`candidature.frontaliereticino.ch`), so the verification
 * e-mail reaches our inbox, never the candidate's.
 *
 *   sign-in page, no account yet  → the "create account" link
 *   create-account page           → random password, stored encrypted BEFORE
 *                                   the click; the planner fills the rest
 *   "check your e-mail"           → the inbox's verification link or code
 *   sign-in page, account known   → alias + password
 *
 * The password never reaches a log, an event or the evidence: the agent masks
 * it and Firestore holds only its AES-GCM envelope under the run key.
 */

import { randomBytes } from 'node:crypto';
import { ASSISTED_APPLICATIONS_COLLECTION, PORTAL_ACCOUNTS_DOC_ID } from '../../../../functions/src/assistedApplicationConstants.js';
import { sameSite } from '../../../../functions/src/assistedApplicationPortalSites.js';
import { decryptJson, encryptJson } from '../secure-run.mjs';

export const VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFICATION_POLL_MS = 10_000;

export const CREATE_ACCOUNT_RE = /^(konto erstellen|neues konto( erstellen)?|registrieren|jetzt registrieren|create (an )?account|sign up|register|crea (un )?account|registrati|créer (un )?compte|s'inscrire)$/i;
export const SIGN_IN_RE = /^(anmelden|einloggen|sign in|log ?in|accedi|connexion|se connecter)$/i;
export const VERIFY_PAGE_RE = /(verify|verifizier|bestätig|verifica|confirm|vérifi)[^.]{0,80}(e-?mail|konto|account|adresse|indirizzo|compte)|check your (e-?mail|inbox)|e-?mail (wurde )?(gesendet|verschickt|sent|inviata|envoyé)/i;
const CODE_FIELD_RE = /code|codice|pin|token|bestätigungs/i;

const VERIFY_OK_RE = /\b(verified|verifiziert|bestätigt|aktiviert|activated|confirmed|verificat[oa]|confermat[oa]|attivat[oa]|vérifiée?|confirmée?|activée?|erfolgreich|successfully)\b/i;
const VERIFY_FAILED_RE = /(abgelaufen|expired|scadut[oa]|expirée?|ungültig|invalid|non valid[oa]|invalide|nicht (mehr )?gültig|falsch|incorrect|errat[oa]|wrong)/i;

/**
 * What the page after the "create account" click says: `refused` (still the
 * form, or its errors), `verify` (the portal asks to confirm the e-mail) or
 * `created` (it moved on).
 */
export function registrationOutcome(after) {
  if (authPageKind(after) === 'create') return 'refused';
  if (VERIFY_PAGE_RE.test(after.text) || codeField(after)) return 'verify';
  if (after.errors?.length) return 'refused';
  return 'created';
}

/**
 * What the page after the verification link or code says. Only a positive
 * state counts as `accepted`: a confirmation, the sign-in page or the
 * application form. An expired or wrong token is `rejected`; anything else
 * `unconfirmed`, and neither is recorded as verified.
 */
export function verificationOutcome(after) {
  if (after.errors?.length || VERIFY_FAILED_RE.test(after.text) || codeField(after)) return 'rejected';
  if (VERIFY_OK_RE.test(after.text) || authPageKind(after) === 'sign_in') return 'accepted';
  if (VERIFY_PAGE_RE.test(after.text)) return 'unconfirmed';
  const form = after.fields.filter((field) => field.inputType !== 'password');
  return form.some((field) => field.kind === 'file') || form.length >= 3 ? 'accepted' : 'unconfirmed';
}

/** create: two password fields (password + repeat); sign_in: one. */
export function authPageKind(snapshot) {
  const passwords = snapshot.fields.filter((field) => field.inputType === 'password').length;
  if (passwords >= 2) return 'create';
  if (passwords === 1) return 'sign_in';
  return 'none';
}

/** 16 random base64 characters plus one of each class the usual policies ask for. */
export function newPortalPassword(bytes = randomBytes(24)) {
  const core = bytes.toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  if (core.length < 16) throw new Error('password_entropy');
  return `${core}Aa7!`;
}

/** Firestore map key for a host (no dots in a field name). */
export function hostKey(host) {
  return String(host || '').toLowerCase().replace(/[^a-z0-9-]/g, '_').slice(0, 120);
}

// A verification link is opened only on the portal's own site (or its ATS
// family); the inbound handler uses the same rule to keep a message from the candidate.
export { sameSite };

export function accountsRefFor(db, orderId) {
  return db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId)).collection('automation').doc(PORTAL_ACCOUNTS_DOC_ID);
}

/**
 * The account store bound to one order: what submitViaPortal receives as
 * `ctx.accounts` (tests inject their own).
 */
export function portalAccountStore({ db, orderId, key, mask = () => {}, nowMs = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const ref = accountsRefFor(db, orderId);
  return {
    async load(host) {
      const entry = (await ref.get()).data()?.[hostKey(host)];
      if (!entry?.passwordEnc) return null;
      const { password } = decryptJson(entry.passwordEnc, key);
      mask(password);
      return { email: entry.email, password, createdAt: entry.createdAt || null, verifiedAt: entry.verifiedAt || null };
    },
    /** Before the "create account" click: `pending` until the portal confirms it. */
    async save(host, { email, password }) {
      mask(password);
      await ref.set({
        [hostKey(host)]: { host: String(host).toLowerCase(), email, passwordEnc: encryptJson({ password }, key), status: 'pending', createdAt: nowMs(), verifiedAt: null, lastSignInAt: null },
      }, { merge: true });
    },
    /**
     * The portal refused the registration (validation error, still on the
     * form): no account exists, so the next run creates it again instead of
     * signing in. The password envelope goes; the entry stays as a trace.
     */
    async discard(host, reason = '') {
      const current = (await ref.get()).data()?.[hostKey(host)];
      if (!current) return;
      await ref.set({ [hostKey(host)]: { ...current, passwordEnc: null, status: 'discarded', discardedAt: nowMs(), discardReason: String(reason).slice(0, 80) } }, { merge: true });
    },
    async mark(host, patch) {
      const current = (await ref.get()).data()?.[hostKey(host)];
      if (!current) return;
      await ref.set({ [hostKey(host)]: { ...current, ...patch } }, { merge: true });
    },
    /**
     * The first verification message classified by the inbound handler after
     * `sinceMs` whose link is on the portal's site (or that carries a code).
     */
    async waitForVerification({ host, sinceMs, timeoutMs = VERIFICATION_TIMEOUT_MS }) {
      const inbox = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId)).collection('inbox');
      const deadline = nowMs() + timeoutMs;
      while (nowMs() < deadline) {
        const snapshot = await inbox.where('receivedAt', '>=', sinceMs).get();
        for (const doc of snapshot.docs) {
          const message = doc.data();
          if (message.category !== 'verification') continue;
          const url = message.verificationUrl && sameSite(message.verificationUrl, host) ? message.verificationUrl : '';
          const code = String(message.verificationCode || '');
          if (url || code) {
            mask(url);
            mask(code);
            return { url, code, messageId: doc.id };
          }
        }
        await sleep(VERIFICATION_POLL_MS);
      }
      return null;
    },
  };
}

export function codeField(snapshot) {
  return snapshot.fields.find((field) => field.kind === 'text' && field.inputType !== 'password' && CODE_FIELD_RE.test(`${field.label} ${field.name}`)) || null;
}

export function loginFields(snapshot) {
  const password = snapshot.fields.find((field) => field.inputType === 'password') || null;
  const email = snapshot.fields.find((field) => field.inputType === 'email')
    || snapshot.fields.find((field) => field.kind === 'text' && field.inputType !== 'password' && /e-?mail|benutzer|user|login/i.test(`${field.label} ${field.name} ${field.autocomplete}`))
    || null;
  return { email, password };
}
