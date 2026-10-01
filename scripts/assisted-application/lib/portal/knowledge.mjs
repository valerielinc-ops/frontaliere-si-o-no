/**
 * What each portal taught the runner, per host (self-correction, level 2).
 *
 * After a submission the portal CONFIRMED, the runner records the buttons it
 * had to learn there: the final button when its name was not a usual one
 * (JOIN's «Conferma e applica», found by the agent), and the step buttons the
 * agent named. The next run on that host recognises them without Codex.
 * Each button is kept with the page it was on (the anonymized path,
 * portal.mjs `anonymizePath`): a label is a control of that page only, never
 * of every page of the host (review of #10741).
 * Nothing is learned from a failure, a dry run or an ambiguous click, so a
 * wrong guess is never remembered; labels and paths are page texts, never
 * candidate data.
 *
 * Server-only collection (no Firestore rule matches it: clients are denied).
 */

export const PORTAL_KNOWLEDGE_COLLECTION = 'assisted_application_portal_knowledge';
// Buttons kept per kind and host, newest first.
const MAX_BUTTONS = 20;

/** "  Conferma e  applica " → "conferma e applica": how a label is compared and stored. */
export function normalizeLabel(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
}

const cleanButton = (button) => ({ path: String(button?.path || '').slice(0, 200), label: normalizeLabel(button?.label) });

const merge = (known = [], learned = []) => {
  const seen = new Set();
  return [...learned, ...known].map(cleanButton).filter((button) => {
    const key = `${button.path} ${button.label}`;
    if (!button.path || !button.label || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_BUTTONS);
};

/** The labels taught on this page (its anonymized path). */
export function labelsAt(buttons = [], path = '') {
  return buttons.filter((button) => button.path === path).map((button) => button.label);
}

/** The first enabled button whose label the portal taught (exact, after normalizing). */
export function learnedButton(buttons, labels = []) {
  const known = new Set(labels.map(normalizeLabel));
  return buttons.find((button) => !button.disabled && known.has(normalizeLabel(button.text))) || null;
}

/** A portal that taught nothing yet (or whose memory cannot be read). */
export const NO_PORTAL_KNOWLEDGE = Object.freeze({ finalButtons: [], nextButtons: [] });

/**
 * @param {{db: import('firebase-admin/firestore').Firestore}} deps
 * @returns {{load(host:string): Promise<{finalButtons:Array<{path:string,label:string}>, nextButtons:Array<{path:string,label:string}>}>, learn(host:string, facts:{finalButton?:{path:string,label:string}|null, nextButtons?:Array<{path:string,label:string}>}): Promise<void>}}
 */
export function portalKnowledgeStore({ db }) {
  const ref = (host) => db.collection(PORTAL_KNOWLEDGE_COLLECTION).doc(String(host || 'unknown').toLowerCase().slice(0, 200));
  return {
    async load(host) {
      const snapshot = await ref(host).get();
      const data = snapshot.exists ? snapshot.data() || {} : {};
      return { finalButtons: merge(data.finalButtons), nextButtons: merge(data.nextButtons) };
    },
    async learn(host, { finalButton = null, nextButtons = [] } = {}) {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref(host));
        const data = snapshot.exists ? snapshot.data() || {} : {};
        transaction.set(ref(host), {
          host: String(host).toLowerCase(),
          finalButtons: merge(data.finalButtons, finalButton ? [finalButton] : []),
          nextButtons: merge(data.nextButtons, nextButtons),
          confirmedSubmissions: Number(data.confirmedSubmissions || 0) + 1,
          updatedAt: Date.now(),
        });
      });
    },
  };
}
