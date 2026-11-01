/** Source-only fingerprint: public job data and candidate files never enter it. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function currentPortalCodeVersion(root = fileURLToPath(new URL('../../../', import.meta.url))) {
  const portal = 'scripts/assisted-application/lib/portal';
  const files = readdirSync(path.join(root, portal)).filter(name => name.endsWith('.mjs')).map(name => `${portal}/${name}`);
  files.push('scripts/lib/prospector/public-fetch-policy.mjs', 'scripts/assisted-application/verify-portal.mjs',
    'scripts/assisted-application/reconcile-portal-code.mjs', 'scripts/assisted-application/reconcile-portal-questions.mjs',
    'scripts/assisted-application/agent.mjs', 'scripts/assisted-application/lib/submit.mjs',
    'scripts/assisted-application/lib/portal-code-version.mjs', 'scripts/assisted-application/extension/apply-control.js',
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
    'functions/src/lib/assistedApplicationQuestionConstraints.js', 'scripts/assisted-application/install-nopecha.sh');
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex');
}
