/**
 * Stable identity for CompanyAlert writes.
 *
 * The client and Cloud Functions bundle mirror this tiny boundary module: the
 * functions deploy is isolated to `functions/` and cannot import a source file
 * from the site bundle. Keeping the input contract deliberately textual makes
 * parity testable without a hashing implementation that could drift.
 */

export function normalizeCompanyAlertEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

export function companyAlertDocumentId(
  email: string,
  specificCompanyKey: string,
  type = 'company',
): string {
  const identity = `${type}|${normalizeCompanyAlertEmail(email)}|${String(specificCompanyKey || '').trim()}`;
  return `${type}_alert_${encodeURIComponent(identity)}`;
}
