/**
 * monitor-scheda.mjs — il blocco `## Scheda` che ogni opener di monitor allega
 * alla issue che conia.
 *
 * ─── Perche' esiste ────────────────────────────────────────────────────────
 *
 * Una issue coniata da un monitor nasce con l'osservatore gia' in mano — e'
 * il monitor stesso — ma finora quell'informazione restava dove nessuno
 * poteva leggerla: `crawler-health` teneva la condizione di chiusura solo
 * dentro il codice del proprio closer, `dmarc` solo in prosa nel corpo della
 * issue, `cf-5xx` da nessuna parte. Chi raccoglie la issue (il fixer
 * autonomo, o una persona) deve ricostruire dal nulla una cosa che lo script
 * che l'ha aperta sapeva gia': **a quale condizione osservabile questa issue
 * si chiude, e con quale comando la si verifica**.
 *
 * `audit-canton-url-drift.mjs` emetteva gia' la forma completa, ma la
 * emetteva a mano: una funzione copiata sarebbe drift garantito al primo
 * monitor che cambia un campo (AGENTS.md Non-Negotiable #6 — un costrutto
 * duplicato letteralmente in >=2 file va estratto in UN modulo). Questo e'
 * quel modulo.
 *
 * ─── L'invariante ──────────────────────────────────────────────────────────
 *
 * `issue-decompose.yml:184`: «Senza il COMANDO della metrica la scheda NON e'
 * valida». Qui e' eseguibile: `buildScheda` LANCIA se `comando` o
 * `osservatore` mancano. Il posto giusto per quel throw e' la costruzione,
 * non il runtime del monitor: `comando` e `osservatore` sono letterali nel
 * codice dell'opener, quindi un throw qui non puo' mai zittire un monitor su
 * un rosso vero — sarebbe rosso in test molto prima, e infatti
 * `tests/monitor-scheda-openers.test.ts` chiama ogni opener e pretende
 * entrambi i campi.
 *
 * Un nome si scrive, un comando si esegue: `OSSERVATORE` dice CHI guarda,
 * `COMANDO` e' la meta' falsificabile. Non e' questo modulo a eseguirli —
 * l'esecuzione e' una decisione aperta del proprietario (scheda D8).
 */

/** L'intestazione del blocco. Cercata alla lettera da chi consuma la scheda. */
export const SCHEDA_HEADING = '## Scheda';

/** @param {string|string[]|undefined} v */
function block(v) {
  if (v == null) return [];
  const lines = Array.isArray(v) ? [...v] : String(v).split('\n');
  // Le righe vuote in coda sono separatori che il blocco aggiunge da se': se
  // il chiamante le porta dentro il campo si ottengono righe vuote doppie.
  while (lines.length && !String(lines[lines.length - 1]).trim()) lines.pop();
  return lines;
}

/** `**N-CAMPO.** <prima riga>` piu' il resto del campo, o niente se il campo e' vuoto. */
function field(label, v) {
  const lines = block(v);
  if (!lines.length) return [];
  return [`**${label}.** ${lines[0]}`, ...lines.slice(1), ''];
}

/**
 * Il blocco `## Scheda` a cinque campi.
 *
 * @param {object} f
 * @param {string|string[]} f.causa        Ipotesi VERIFICABILE, non il sintomo.
 * @param {string|string[]} f.fix          Cosa cambia e dove; `| **REPO**: …` se utile.
 * @param {string} f.metrica               Una riga sola: `prima=<n> atteso=<n>`.
 * @param {string} f.comando               Comando eseguibile che rimisura la metrica. Obbligatorio.
 * @param {string|string[]} f.osservatore  Chi riapre/chiude, e dove vive la serie. Obbligatorio.
 * @param {string} [f.fallimento]          Il titolo che ricompare se il difetto torna.
 * @param {string|string[]} [f.note]       Righe libere dopo la riga della metrica.
 * @returns {string} markdown
 */
export function buildScheda({ causa, fix, metrica, comando, osservatore, fallimento, note }) {
  const cmd = String(comando ?? '').trim();
  if (!cmd) throw new Error('buildScheda: COMANDO mancante — senza comando la scheda non e\' valida');
  if (cmd.includes('\n')) throw new Error('buildScheda: COMANDO su piu\' righe — deve stare su una riga sola');
  if (!block(osservatore).join('').trim()) throw new Error('buildScheda: OSSERVATORE mancante');

  const out = [
    SCHEDA_HEADING,
    '',
    ...field('1-CAUSA', causa),
    ...field('2-FIX', fix),
    `**3-METRICA.** ${String(metrica ?? '').trim()} | **COMANDO**: \`${cmd}\``,
    '',
    ...block(note).length ? [...block(note), ''] : [],
    ...field('4-OSSERVATORE', osservatore),
    ...fallimento ? [`**5-FALLIMENTO.** ${fallimento}`, ''] : [],
  ];
  return out.join('\n').replace(/\n+$/, '\n');
}
