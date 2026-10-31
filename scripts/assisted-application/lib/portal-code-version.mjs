/** Source-only fingerprint: public job data and candidate files never enter it. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function currentPortalCodeVersion(root = fileURLToPath(new URL('../../../', import.meta.url))) {
  const portal = 'scripts/assisted-application/lib/portal';
  const files = readdirSync(path.join(root, portal)).filter(name => name.endsWith('.mjs')).map(name => `${portal}/${name}`);
  files.push('scripts/assisted-application/reconcile-portal-code.mjs', 'scripts/assisted-application/agent.mjs', 'scripts/assisted-application/lib/submit.mjs',
    'scripts/assisted-application/lib/portal-code-version.mjs', 'scripts/assisted-application/extension/apply-control.js',
    'functions/src/assistedApplicationConstants.js', 'functions/src/assistedApplicationRetention.js',
    'functions/src/assistedApplicationPortalSites.js',
    'functions/src/assistedApplicationExtraDocuments.js', 'functions/src/assistedApplicationOperationalAnswers.js', 'functions/src/assistedApplicationCandidateEdits.js',
    'functions/src/assistedApplicationFlow.js', 'functions/src/assistedApplicationPortalRetryPolicy.js',
    'functions/src/assistedApplicationPortalRecoveryPolicy.js', 'functions/src/assistedApplicationSubmissionGuard.js',
    'functions/src/lib/applicationConsent.js', 'functions/src/lib/portalNativeContract.js', 'functions/src/lib/answerRules.js', 'functions/src/lib/portalQuestionText.js', 'scripts/assisted-application/install-nopecha.sh');
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex');
}
