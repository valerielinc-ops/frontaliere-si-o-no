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
    'functions/src/lib/answerRules.js', 'functions/src/lib/portalQuestionText.js', 'functions/src/lib/portalNativeContract.js', 'scripts/assisted-application/install-nopecha.sh');
  files.push('functions/src/assistedApplicationReceiptReconcile.js', 'functions/src/lib/submissionReceiptContract.js', 'functions/src/lib/qualificationCounterContext.js', 'functions/src/lib/submittedOrderFields.js', 'functions/src/assistedApplicationExecution.js', 'functions/src/assistedApplicationEligibility.js', 'functions/src/codexFallback.js',
    'functions/src/lib/assistedApplicationRetentionPolicy.js', 'functions/src/lib/assistedApplicationArtifactRetention.js', 'functions/src/assistedApplicationFollowup.js', 'scripts/assisted-application/lib/secure-run.mjs', 'scripts/assisted-application/lib/draft.mjs', 'scripts/assisted-application/lib/docx-inplace.mjs',
    'functions/src/lib/portalChannels.js', 'functions/src/lib/portalInfrastructureEvidence.js',
    'scripts/assisted-application/remote-controller.mjs', 'scripts/assisted-application/remote-executor.mjs',
    'scripts/assisted-application/supervised-agent.mjs', 'scripts/assisted-application/lib/execution-runtime.mjs',
    'scripts/assisted-application/lib/execution-release.mjs', 'scripts/assisted-application/lib/execution-artifacts.mjs',
    'scripts/assisted-application/lib/execution-process.mjs',
    'scripts/assisted-application/lib/browser-ownership.mjs', 'scripts/assisted-application/lib/process-registry.mjs',
    'scripts/assisted-application/lib/browser-egress.mjs', 'scripts/lib/prospector/public-fetch-policy.mjs',
    'scripts/assisted-application/nopecha-e2e.mjs',
    'scripts/assisted-application/lib/darwin-isolation.mjs', 'scripts/assisted-application/report-runner-failure.mjs',
    '.github/actions/setup-codex-darwin-broker/bootstrap.mjs', '.github/actions/setup-codex-darwin-broker/native-auth.mjs', '.github/actions/setup-codex-darwin-broker/sandbox-probe.mjs', '.github/actions/setup-codex-darwin-broker/process-privacy-probe.mjs',
    '.github/actions/setup-claude-haiku-fallback/codex-auth-broker.mjs', '.github/actions/setup-claude-haiku-fallback/broker-permissions.mjs', '.github/actions/setup-claude-haiku-fallback/concierge-tools.mjs', '.github/actions/setup-claude-haiku-fallback/concierge-model-source.json', '.github/actions/setup-claude-haiku-fallback/concierge-tool-probe.mjs', '.github/actions/setup-claude-haiku-fallback/action.yml');
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex');
}
