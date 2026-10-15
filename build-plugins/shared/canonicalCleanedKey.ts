/**
 * canonicalCleanedKey — la chiave di `canonicalCleanedCache`, in UNA definizione.
 *
 * ─── Cosa c'era prima, e quanto costava ─────────────────────────────────
 *
 * La chiave era la CONCATENAZIONE stessa:
 *
 *     `${description.length}${description}${requirements.join('')}`
 *
 * scritta identica in due punti di `jobsSeoPagesPlugin.ts` (il memo
 * `memoCanonicalCleaned` e il pre-pass a worker). Come identita' e' corretta;
 * come oggetto in memoria e' una **copia intera del testo dell'annuncio**, e
 * quel testo e' il grosso di `data/jobs.json` (331 MB su disco).
 *
 * Il costo non e' una copia sola. Nel pre-pass, misurato sul run 31747139648
 * (leg it, `[jobs-seo-profile] canonical-fallback-pre-pass tuples=20051
 * workers=4`, cache finale `size=20793`), la stessa stringa e' viva
 * contemporaneamente in cinque posti:
 *
 *   1. `tuples[i].key`
 *   2. il Set `seen` (stessi oggetti stringa, quindi gratis — ma tiene in vita)
 *   3. i 4 chunk passati come `workerData`, che il **structured clone COPIA**
 *      dentro l'isolate di ogni worker
 *   4. gli array `entries[]` che i worker rispediscono, clonati di nuovo
 *   5. `canonicalCleanedCache`, che le trattiene fino a `clear()` — cioe' per
 *      tutta la fase di emissione degli annunci attivi
 *
 * E il pre-pass gira **esattamente sul picco**: fra le milestone
 * `[mem] jobsSeoPages: collector created` (heapUsed 4230 MB) e
 * `[mem] jobsSeoPages: after company-landing` (heapUsed 8507 MB), il salto di
 * +4277 MB di heap VIVO (post-GC forzata) che domina l'intera build.
 *
 * ─── Cosa cambia ────────────────────────────────────────────────────────
 *
 * La chiave diventa un digest di lunghezza fissa (40 char esadecimali) dello
 * **stesso identico flusso di byte**: `String(description.length)`, poi
 * `description`, poi ogni requirement in ordine, senza separatori. Le classi
 * di equivalenza sono le stesse di prima, bit per bit — non e' una chiave
 * nuova, e' la vecchia chiave non trattenuta.
 *
 * Il digest si costruisce in modo INCREMENTALE apposta: `update()` per pezzo
 * invece di concatenare e poi hashare. Concatenare rifarebbe la stringa
 * grande che stiamo togliendo, solo per un istante — e un istante, dentro un
 * ciclo da 20k iterazioni al picco di memoria, e' un transiente da centinaia
 * di MB che la GC deve inseguire.
 *
 * ─── Perche' sha1 e non un hash piu' corto ──────────────────────────────
 *
 * E' una cache di memoizzazione: una collisione non da' un errore, da' una
 * pagina renderizzata con il contenuto di un ALTRO annuncio, in silenzio. Su
 * ~21k chiavi un digest a 64 bit avrebbe una probabilita' di collisione
 * dell'ordine di 1e-8 per build — piccola, ma il guasto sarebbe invisibile e
 * permanente. Con 160 bit non e' un rischio che vada ponderato. `sha1` e' gia'
 * la primitiva usata da `sharedWriteRegistry.ts` per lo stesso tipo di
 * identita'-di-contenuto in questa build.
 */
import { createHash } from 'node:crypto';

/**
 * @param description testo dell'annuncio nella lingua richiesta.
 * @param requirements requisiti gia' normalizzati a stringhe.
 * @returns digest esadecimale a 40 caratteri, stabile e indipendente dal
 *   locale (la chiave e' locale-invariante per costruzione: e' cio' che fa
 *   funzionare il riuso cross-locale della cache).
 */
export function canonicalCleanedKey(description: string, requirements: readonly string[]): string {
  const h = createHash('sha1');
  // Il prefisso di lunghezza c'era anche prima e resta: senza, `desc="ab"` +
  // `reqs=["c"]` e `desc="abc"` + `reqs=[]` avrebbero lo stesso flusso.
  h.update(String(description.length));
  h.update(description);
  for (const r of requirements) h.update(r);
  return h.digest('hex');
}
