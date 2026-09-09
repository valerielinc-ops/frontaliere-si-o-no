/**
 * Runtime mirror of services/companyAlertIdentity.ts.
 *
 * Cloud Functions deploys only this directory, so importing the site module is
 * not a runtime option. The contract is intentionally kept to normalisation +
 * encodeURIComponent; tests pin the same id for client and token writers.
 */

export function normalizeCompanyAlertEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function companyAlertDocumentId(email, specificCompanyKey, type = 'company') {
  const identity = `${type}|${normalizeCompanyAlertEmail(email)}|${String(specificCompanyKey || '').trim()}`;
  return `${type}_alert_${encodeURIComponent(identity)}`;
}
