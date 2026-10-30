/**
 * Interruttori della campagna «durata del deploy» per i plugin medi del build.
 * Ogni ottimizzazione e' una pura riduzione di lavoro (stesso output byte per
 * byte, provato da test di equivalenza e, sul banco, da DIST_HASH_MANIFEST) e
 * ha un interruttore con cui tornare al percorso storico senza toccare il
 * codice: accese di default, `MID_PLUGINS_FAST=0` le spegne.
 * (Le ottimizzazioni che vivono in scripts/lib leggono lo stesso valore da
 * scripts/lib/mid-plugins-flag.mjs.)
 */
import { MID_PLUGINS_FAST } from '../../scripts/lib/mid-plugins-flag.mjs';
export { MID_PLUGINS_FAST };

export const EARLY_REJECT_ENV = 'MID_PLUGINS_FAST';
export function earlyRejectEnabled(): boolean {
  return MID_PLUGINS_FAST;
}
