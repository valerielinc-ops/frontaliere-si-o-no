/** Source-only fingerprint: public job data and candidate files never enter it. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function currentPortalCodeVersion(root = fileURLToPath(new URL('../../../', import.meta.url))) {
  const portal = 'scripts/assisted-application/lib/portal';
  const files = readdirSync(path.join(root, portal)).filter(name => name.endsWith('.mjs')).map(name => `${portal}/${name}`);
  files.push('scripts/assisted-application/agent.mjs', 'scripts/assisted-application/lib/submit.mjs',
    'scripts/assisted-application/lib/portal-code-version.mjs', 'scripts/assisted-application/extension/apply-control.js',
    'functions/src/assistedApplicationOperationalAnswers.js', 'functions/src/assistedApplicationCandidateEdits.js',
    'functions/src/assistedApplicationFlow.js', 'functions/src/assistedApplicationPortalRetryPolicy.js',
    'functions/src/assistedApplicationPortalRecoveryPolicy.js', 'functions/src/assistedApplicationSubmissionGuard.js',
    'functions/src/lib/answerRules.js', 'functions/src/lib/portalQuestionText.js', 'scripts/assisted-application/install-nopecha.sh');
  files.push('functions/src/assistedApplicationExecution.js', 'functions/src/assistedApplicationEligibility.js',
    'functions/src/lib/portalChannels.js', 'functions/src/lib/portalInfrastructureEvidence.js',
    'scripts/assisted-application/remote-controller.mjs', 'scripts/assisted-application/remote-executor.mjs',
    'scripts/assisted-application/supervised-agent.mjs', 'scripts/assisted-application/lib/execution-runtime.mjs',
    'scripts/assisted-application/lib/execution-release.mjs', 'scripts/assisted-application/lib/execution-artifacts.mjs',
    'scripts/assisted-application/lib/darwin-isolation.mjs', 'scripts/assisted-application/report-runner-failure.mjs',
    '.github/actions/setup-codex-darwin-broker/bootstrap.mjs', '.github/actions/setup-codex-darwin-broker/sandbox-probe.mjs',
    '.github/actions/setup-claude-haiku-fallback/codex-auth-broker.mjs', '.github/actions/setup-claude-haiku-fallback/broker-permissions.mjs');
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex');
}
