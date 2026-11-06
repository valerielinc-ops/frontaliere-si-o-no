/**
 * Interruttore della campagna «durata del deploy»: le riduzioni di lavoro dei
 * plugin medi del build che hanno un equivalente puro (stesso output byte per
 * byte, provato da test di equivalenza e dal confronto del dist sul banco
 * deploy-matrix-experiment con compare_variants).
 *
 * Accese di default; `MID_PLUGINS_FAST=0` ripristina il percorso storico (il
 * rollback non richiede una modifica al codice). Letto una volta al
 * caricamento del modulo: il build lo riceve dall'ambiente del processo prima
 * dell'avvio.
 */
export const MID_PLUGINS_FAST = process.env.MID_PLUGINS_FAST !== '0';
