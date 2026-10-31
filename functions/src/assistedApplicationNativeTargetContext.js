/** Primary source metadata for one owner kit; no client protocol or entered value can construct this context. */
import { createHash } from 'node:crypto';
import { canonicalQuestionJson } from './lib/applicationQuestionContract.js';

const unavailable = () => Object.assign(new Error('native_target_source_unavailable'), { code: 'native_target_source_unavailable', status: 409 });

/** Called identically at kit issuance and before final proof, never from inside a Firestore transaction. */
export async function loadNativeTargetContext({ order, draft, answerSourceGuard, signal = null }) {
  if (!/^[a-f0-9]{64}$/.test(answerSourceGuard?.fingerprint || '') || typeof answerSourceGuard?.assertInTransaction !== 'function') throw unavailable();
  // The title belongs to the actual order/draft, never to the protocol being checked.
  const applyUrl = order?.jobUrl || draft?.job?.applyUrl;
  const jobTitle = order?.jobTitle || draft?.job?.title;
  if (typeof applyUrl !== 'string' || !applyUrl || typeof jobTitle !== 'string' || !jobTitle || signal?.aborted) throw unavailable();
  let readPrimaryApplicationProtocol; let nativeApplicationSourceFingerprint; let nativeApplicationSourceAuthority;
  try {
    ({ readPrimaryApplicationProtocol } = await import('./lib/primaryApplicationProtocol.js'));
    ({ nativeApplicationSourceFingerprint, nativeApplicationSourceAuthority } = await import('./lib/nativeApplicationTarget.js'));
  } catch { throw unavailable(); }
  if (typeof readPrimaryApplicationProtocol !== 'function' || typeof nativeApplicationSourceFingerprint !== 'function' || typeof nativeApplicationSourceAuthority !== 'function') throw unavailable();
  const primary = await readPrimaryApplicationProtocol({ applyUrl, jobTitle }, { signal });
  if (!primary || signal?.aborted) throw unavailable();
  const expected = { applyUrl: primary.applyUrl, sourceProtocol: primary.sourceProtocol, jobTitle };
  // The shared codec revalidates ALL forms and the real source title before selecting stable semantics.
  // Raw quoted forms remain intact for target validation; unrelated CSRF/time values never change the kit's identity.
  const sourceFingerprint = nativeApplicationSourceFingerprint(expected);
  const sourceAuthority = nativeApplicationSourceAuthority(expected);
  if (typeof sourceFingerprint !== 'string' || !sourceFingerprint || !sourceAuthority) throw unavailable();
  const fingerprint = createHash('sha256').update(canonicalQuestionJson({ version: 'owner-native-source-frame-v1',
    answerSourceFingerprint: answerSourceGuard.fingerprint, primarySource: sourceFingerprint })).digest('hex');
  const sourceGuard = Object.freeze({ fingerprint,
    async assertInTransaction(transaction) { await answerSourceGuard.assertInTransaction(transaction); },
  });
  return { expected, sourceGuard, sourceAuthority: { ...sourceAuthority, sourceFingerprint },
    nativeTargetContext: structuredClone({ applyUrl: primary.applyUrl, sourceProtocol: primary.sourceProtocol, jobTitle }) };
}
