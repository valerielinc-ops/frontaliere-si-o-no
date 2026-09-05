import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Simmetria di case fra le due metà di ogni confronto d'identità in
 * `firestore.rules` (#6681, follow-up di #6670).
 *
 * Le regole che proteggono un documento keyato dall'indirizzo confrontano
 * `request.auth.token.email.lower()` con il segmento di path `{email}`. Il lato
 * token era già normalizzato; il lato DOCUMENTO era dato per scontato, sulla
 * fiducia che `normalizeNewsletterEmail` giri prima di ogni scrittura — ma le
 * rules quella funzione non la vedono, e un documento può arrivare da un
 * import, una migrazione o uno script Admin SDK, che questo file non lo
 * valutano affatto. Un id con una maiuscola e il proprietario vero
 * dell'indirizzo resta chiuso fuori dal proprio record di consenso per sempre,
 * in silenzio: `token.email.lower()` non eguaglierà mai un id a case misto.
 *
 * Statico di proposito — nessun emulatore, quindi gira nel gate bloccante
 * insieme a tutto il resto (`tests/firestore-rules-consent-write.test.ts` ha
 * bisogno di Java 21+ ed è escluso da `run-related-tests.mjs`). Qui non si
 * verifica il comportamento a runtime del guard, solo che nessun confronto
 * nuovo dimentichi il `.lower()` sul lato doc-id.
 */

const ROOT = resolve(import.meta.dirname, '..');

/**
 * Ogni confronto fra l'email del token e qualcos'altro, con il lato destro
 * catturato per intero: o una stringa quotata, o un identificatore con la sua
 * eventuale chiamata `()` — senza quest'ultima `email.lower()` verrebbe
 * troncato alla parentesi e segnalato come non normalizzato.
 */
const IDENTITY_COMPARISON_RE =
  /request\.auth\.token\.email\.lower\(\)\s*==\s*('[^']*'|[A-Za-z_][A-Za-z0-9_.]*(?:\(\))?)/g;

/**
 * Il lato destro è accettabile in due forme sole:
 * - una costante già minuscola (`'valerielinc@gmail.com'` di `isSiteAdmin()`);
 * - una variabile su cui è chiamato `.lower()` (il segmento di path `{email}`).
 */
function isCaseSafe(rhs: string): boolean {
  const literal = rhs.match(/^'([^']*)'$/);
  if (literal) return literal[1] === literal[1].toLowerCase();
  return /^[A-Za-z_][A-Za-z0-9_]*\.lower\(\)$/.test(rhs);
}

/** Le righe di codice, senza commenti: la prosa cita i confronti a esempio. */
function rulesCode(): string {
  return readFileSync(resolve(ROOT, 'firestore.rules'), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('firestore.rules — confronti d\'identità case-insensitive su entrambi i lati', () => {
  it('ogni confronto con token.email.lower() ha un lato destro già minuscolo', () => {
    const offenders = [...rulesCode().matchAll(IDENTITY_COMPARISON_RE)]
      .map((m) => m[1])
      .filter((rhs) => !isCaseSafe(rhs));
    expect(
      offenders,
      'confronti in cui il lato destro non è normalizzato: un doc-id a case misto '
        + '(import, migrazione, script Admin SDK — nessuno passa da '
        + 'normalizeNewsletterEmail) chiuderebbe fuori il proprietario legittimo per '
        + 'sempre. Usa `<segmento>.lower()`, o una costante già minuscola.',
    ).toEqual([]);
  });

  it('sorveglia tutti i confronti presenti, non zero', () => {
    // Una regex che smette di matchare passerebbe verde a vuoto: al 2026-09-05
    // i confronti sono 7 (isSiteAdmin + 6 rule keyate sull'indirizzo).
    const found = [...rulesCode().matchAll(IDENTITY_COMPARISON_RE)];
    expect(found.length).toBeGreaterThanOrEqual(7);
  });
});
