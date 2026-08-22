/**
 * Da chiave crawler a identificatori JavaScript validi.
 *
 * Viveva inline in `scaffold-crawler.mjs` come due `replace` e una
 * concatenazione, e aveva un difetto che nessun crawler scritto a mano ha mai
 * colpito: `companyKey.replace(/-([a-z])/g, ...)` toglie il trattino SOLO se
 * seguito da una lettera minuscola. Una chiave come `recruitingapp-2862` — la
 * forma normale dei tenant su un ATS multi-tenant — generava quindi
 * `isRecruitingapp-2862Job`, che non e' JavaScript: il parser non si carica
 * nemmeno, e il crawler fallisce al primo import invece che con un errore
 * comprensibile.
 *
 * Estratto qui perche' un difetto del genere si verifica in tre righe di test e
 * non si verifica affatto finche' resta dentro uno script che si esegue per
 * intero appena lo importi.
 */

/**
 * Prefisso per le costanti esportate: `MY_COMPANY_KEY`.
 *
 * @param {string} companyKey
 * @returns {string}
 */
export function constPrefix(companyKey = '') {
  return String(companyKey).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Nome in PascalCase per funzioni: `fetchAllMyCompanyJobs`.
 *
 * Un identificatore non puo' iniziare con una cifra, quindi una chiave che
 * comincia con un numero prende un prefisso invece di produrre codice rotto.
 *
 * @param {string} companyKey
 * @returns {string}
 */
export function pascalIdentifier(companyKey = '') {
  const camel = String(companyKey)
    .replace(/[^a-zA-Z0-9]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '');
  if (!camel) return 'Company';
  const pascal = camel.charAt(0).toUpperCase() + camel.slice(1);
  return /^[0-9]/.test(pascal) ? `C${pascal}` : pascal;
}
