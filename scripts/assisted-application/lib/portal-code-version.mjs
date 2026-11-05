/** Source-only fingerprint: public job data and candidate files never enter it. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const defaultRoot = fileURLToPath(new URL('../../../', import.meta.url));

function sourcesBelow(root, relativeDirectory) {
  const absoluteDirectory = path.join(root, ...relativeDirectory.split('/'));
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) return sourcesBelow(root, relativePath);
    return entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name) ? [relativePath] : [];
  });
}

/** One source list drives hashing and its recovery-workflow coverage check. */
export function portalCodeFingerprintFiles(root = defaultRoot) {
  return [...new Set([
    ...sourcesBelow(root, 'scripts/assisted-application/lib'),
    'scripts/lib/prospector/public-fetch-policy.mjs', 'scripts/assisted-application/verify-portal.mjs',
    'scripts/assisted-application/reconcile-portal-code.mjs', 'scripts/assisted-application/reconcile-portal-questions.mjs',
    'scripts/assisted-application/agent.mjs', 'scripts/assisted-application/extension/apply-control.js',
    'functions/src/assistedApplicationConstants.js', 'functions/src/assistedApplicationRetention.js',
    'functions/src/assistedApplicationPortalSites.js',
    'functions/src/assistedApplicationExtraDocuments.js', 'functions/src/assistedApplicationOperationalAnswers.js', 'functions/src/assistedApplicationCandidateEdits.js',
    'functions/src/assistedApplicationFlow.js', 'functions/src/assistedApplicationPortalRetryPolicy.js',
    'functions/src/assistedApplicationPortalRecoveryPolicy.js', 'functions/src/assistedApplicationSubmissionGuard.js',
    'functions/src/assistedApplicationAnswerEvidence.js', 'functions/src/lib/candidateAnswerFacts.js', 'functions/src/lib/languageFacts.js',
    'functions/src/assistedApplicationAutomation.js', 'functions/src/assistedApplicationAutomationAdmin.js',
    'functions/src/assistedApplicationCvCommit.js', 'functions/src/assistedApplicationReview.js',
    'functions/src/lib/addressContextContract.js', 'functions/src/lib/permitStatus.js', 'functions/src/lib/applicationConsent.js',
    'functions/src/lib/portalNativeContract.js', 'functions/src/lib/answerRules.js', 'functions/src/lib/portalQuestionText.js',
    'functions/src/lib/assistedApplicationQuestionConstraints.js', 'functions/src/lib/identityEmail.js',
    'scripts/assisted-application/install-nopecha.sh',
  ])].sort();
}

export function currentPortalCodeVersion(root = defaultRoot) {
  const hash = createHash('sha256');
  for (const file of portalCodeFingerprintFiles(root)) {
    hash.update(file).update('\0').update(readFileSync(path.join(root, ...file.split('/')))).update('\0');
  }
  return hash.digest('hex');
}
