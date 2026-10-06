const AUDIT_STATUS_REASONS = {
  missing: 'nessun dominio ufficiale verificato',
  broken: 'sorgente ufficiale irraggiungibile o riferimento rotto',
  partial: 'copertura parziale',
  'low-quality': 'qualità insufficiente',
  'quality-unverified': 'qualità non verificabile',
  unverified: 'sorgente non verificabile',
};

export function selectAuditCandidates(entries = []) {
  return entries.filter((entry) => (
    entry?.status === 'missing' && String(entry?.companyKey || '').trim()
  ));
}

export function auditIssueReason(company = {}) {
  return String(company.reason || '').trim()
    || AUDIT_STATUS_REASONS[company.status]
    || 'anomalia logo non classificata';
}

export function buildResidualReport(report, acquisition = {}) {
  const results = new Map(
    (acquisition.targets || [])
      .filter((result) => result?.companyKey)
      .map((result) => [result.companyKey, result]),
  );
  const residual = (report.affectedCompanies || [])
    .filter((company) => results.get(company.companyKey)?.status !== 'verified')
    .map((company) => ({
      ...company,
      reason: auditIssueReason(results.get(company.companyKey) || company),
    }));

  const countCompanies = (status) => residual.filter((company) => company.status === status).length;
  const countJobs = (field, status = null) => residual
    .filter((company) => status === null || company.status === status)
    .reduce((sum, company) => sum + Number(company[field] || 0), 0);

  return {
    ...report,
    affectedCompanies: residual,
    companies: residual.filter((company) => company.status === 'missing'),
    missing: countCompanies('missing'),
    missingJobCount: countJobs('missingJobCount', 'missing'),
    broken: countCompanies('broken'),
    brokenJobCount: countJobs('brokenJobCount', 'broken'),
    partial: countCompanies('partial'),
    partialJobCount: countJobs('affectedJobCount', 'partial'),
    lowQuality: residual.filter((company) => Number(company.lowQualityJobCount || 0) > 0).length,
    lowQualityJobCount: countJobs('lowQualityJobCount'),
    qualityUnverified: residual.filter((company) => Number(company.qualityUnverifiedJobCount || 0) > 0).length,
    qualityUnverifiedJobCount: countJobs('qualityUnverifiedJobCount'),
    unverified: countCompanies('unverified'),
    unverifiedJobCount: countJobs('unverifiedJobCount', 'unverified'),
    acquisition: {
      acquired: Number(acquisition.acquired || 0),
      failed: Number(acquisition.failed || 0),
      qualityRejected: Number(acquisition.qualityRejected || 0),
    },
  };
}
