/**
 * What each portal taught the runner, per host (self-correction, level 2).
 *
 * After a submission the portal CONFIRMED, the runner records the labels it
 * had to learn there: the final button when its name was not a usual one
 * (JOIN's «Conferma e applica», found by the agent), and the step buttons the
 * agent named. The next run on that host recognises them without Codex.
 * Nothing is learned from a failure, a dry run or an ambiguous click, so a
 * wrong guess is never remembered; labels are page texts, never candidate data.
 *
 * Server-only collection (no Firestore rule matches it: clients are denied).
 */

export const PORTAL_KNOWLEDGE_COLLECTION = 'assisted_application_portal_knowledge';
// Labels kept per kind and host, newest first.
const MAX_LABELS = 10;

/** "  Conferma e  applica " → "conferma e applica": how a label is compared and stored. */
export function normalizeLabel(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
}

const merge = (known = [], learned = []) => [...new Set([...learned.map(normalizeLabel).filter(Boolean), ...known])].slice(0, MAX_LABELS);

/** The first enabled button whose label the portal taught (exact, after normalizing). */
export function learnedButton(buttons, labels = []) {
  const known = new Set(labels.map(normalizeLabel));
  return buttons.find((button) => !button.disabled && known.has(normalizeLabel(button.text))) || null;
}

/**
 * @param {{db: import('firebase-admin/firestore').Firestore}} deps
 * @returns {{load(host:string): Promise<{finalLabels:string[], nextLabels:string[]}>, learn(host:string, facts:{finalLabel?:string, nextLabels?:string[]}): Promise<void>}}
 */
export function portalKnowledgeStore({ db }) {
  const ref = (host) => db.collection(PORTAL_KNOWLEDGE_COLLECTION).doc(String(host || 'unknown').toLowerCase().slice(0, 200));
  return {
    async load(host) {
      const snapshot = await ref(host).get();
      const data = snapshot.exists ? snapshot.data() || {} : {};
      return { finalLabels: data.finalLabels || [], nextLabels: data.nextLabels || [] };
    },
    async learn(host, { finalLabel = '', nextLabels = [] } = {}) {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref(host));
        const data = snapshot.exists ? snapshot.data() || {} : {};
        transaction.set(ref(host), {
          host: String(host).toLowerCase(),
          finalLabels: merge(data.finalLabels, finalLabel ? [finalLabel] : []),
          nextLabels: merge(data.nextLabels, nextLabels),
          confirmedSubmissions: Number(data.confirmedSubmissions || 0) + 1,
          updatedAt: Date.now(),
        });
      });
    },
  };
}
