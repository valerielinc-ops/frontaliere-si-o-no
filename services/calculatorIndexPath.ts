import { SLUG_TABLES } from './routeSlugs.data';

const PREFIX: Record<keyof typeof SLUG_TABLES, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };

/**
 * `/calcola-stipendio/` e i suoi equivalenti: pagine indicizzate con canonical
 * proprio. buildPath() riporta il calcolatore alla radice, quindi il router deve
 * riconoscerle per non riscriverne l'URL dopo l'idratazione.
 */
export function isCalculatorIndexPath(path: string): boolean {
 const normalized = path.replace(/\/+$/, '');
 return (Object.keys(SLUG_TABLES) as Array<keyof typeof SLUG_TABLES>).some(
  (locale) => normalized === `${PREFIX[locale]}/${SLUG_TABLES[locale].calcolatore}`,
 );
}
