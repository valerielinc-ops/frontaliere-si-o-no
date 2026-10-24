/**
 * Interruttori della campagna «durata del deploy» per i plugin medi del build.
 * Ogni ottimizzazione e' una pura riduzione di lavoro (stesso output byte per
 * byte, provato sul banco con DIST_HASH_MANIFEST) e ha un interruttore con cui
 * tornare al percorso storico senza toccare il codice.
 *
 *  - `MID_PLUGINS_EARLY_REJECT`: legacy-redirects e cf-hot-404-bridge scartano
 *    PRIMA di ogni controllo di sicurezza del path i candidati che un'altra
 *    gamba possiede o che appartengono al job board (nessuna scrittura, in
 *    nessun caso, per quei candidati).
 */
export function midPluginFlag(name: string): boolean {
  return process.env[name] === '1';
}

export const EARLY_REJECT_ENV = 'MID_PLUGINS_EARLY_REJECT';
export function earlyRejectEnabled(): boolean {
  return midPluginFlag(EARLY_REJECT_ENV);
}
