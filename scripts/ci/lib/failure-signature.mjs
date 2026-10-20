import { createHash } from 'node:crypto';

/** Quanto della firma resta leggibile prima del digest. */
export const SIGNATURE_MAX_LEN = 300;

/** Il marker leggibile a macchina che porta la firma dentro il thread. */
export const SIGNATURE_MARKER = 'failure-signature:';

/**
 * La FIRMA di un guasto: quali job, e in quale step, sono caduti.
 *
 * L'insieme ordinato delle coppie `job — step` cadute, con il parentetico
 * finale tolto da entrambi i nomi, distingue un guasto nuovo da una
 * ricorrenza anche quando una issue è ancora fresca. Un startup failure ha
 * zero job e una firma propria, perché «la run non è partita» è una
 * condizione distinta e va potuta seguire. `null` indica job illeggibili o
 * assenza di un job/step fallito.
 *
 * Questo modulo è condiviso dal reporter che scrive il marker e dallo scanner
 * che lo legge: mantenere la normalizzazione in un solo punto evita che i due
 * lati aprano duplicati quando GitHub espone la stessa matrice con nomi
 * parentetici diversi.
 *
 * @param {{total_count?: number, jobs?: Array<{name?: string, conclusion?: string, steps?: Array<{name?: string, conclusion?: string}>}>}|null} jobs
 * @returns {string|null}
 */
export function failureSignature(jobs) {
  if (!jobs || typeof jobs !== 'object') return null;
  if (Number(jobs.total_count) === 0) return 'startup-failure: zero job';
  if (!Array.isArray(jobs.jobs)) return null;
  const strip = (v) => String(v ?? '').replace(/\s*\([^()]*\)\s*$/, '').trim();
  const pairs = new Set();
  for (const j of jobs.jobs) {
    if (j?.conclusion !== 'failure') continue;
    const step = (j.steps || []).find((st) => st?.conclusion === 'failure');
    pairs.add(`${strip(j.name) || '(job senza nome)'} — step: ${step ? (strip(step.name) || '(step senza nome)') : '(nessuno step attribuito)'}`);
  }
  if (!pairs.size) return null;
  const full = [...pairs].sort().join(' | ');
  if (full.length <= SIGNATURE_MAX_LEN) return full;
  // TRONCARE E BASTA sarebbe un silenzio: due guasti che condividono i primi
  // 300 caratteri collasserebbero sulla stessa firma. Il digest della stringa
  // intera rende il prefisso iniettivo anche per matrici molto larghe.
  const digest = createHash('sha256').update(full).digest('hex').slice(0, 12);
  return `${full.slice(0, SIGNATURE_MAX_LEN)}… +${pairs.size} coppie (sha ${digest})`;
}

/**
 * Serializza una firma nel formato che lo scanner riconosce.
 * @param {string|null|undefined} signature
 */
export function signatureMarker(signature) {
  return signature ? `\n\n<!-- ${SIGNATURE_MARKER} ${signature} -->` : '';
}
