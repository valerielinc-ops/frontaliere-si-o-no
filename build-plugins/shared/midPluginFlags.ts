/**
 * Interruttori della campagna «durata del deploy» per i plugin medi del build.
 * Ogni ottimizzazione e' una pura riduzione di lavoro (stesso output byte per
 * byte, provato da test di equivalenza e, sul banco, da DIST_HASH_MANIFEST) e
 * ha un interruttore con cui tornare al percorso storico senza toccare il
 * codice: `MID_PLUGINS_FAST=1` le accende, ogni altro valore le spegne.
 * (Le ottimizzazioni che vivono in scripts/lib leggono lo stesso valore da
 * scripts/lib/mid-plugins-flag.mjs.)
 */
export { MID_PLUGINS_FAST } from '../../scripts/lib/mid-plugins-flag.mjs';

export const EARLY_REJECT_ENV = 'MID_PLUGINS_FAST';
export function earlyRejectEnabled(): boolean {
  return process.env.MID_PLUGINS_FAST === '1';
}
