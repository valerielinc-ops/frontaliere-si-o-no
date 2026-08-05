/**
 * secrets-scope-detect — zero-Claude pre-promotion gate for followup-drainer.mjs
 * (escalation #5057, bucket fix-outcome:blocked-secrets 6x/14d).
 *
 * `cloudflare-5xx` / `campaign-goal` / `evergreen-refresh` issues structurally
 * require a Firebase-RC-loaded credential never available to `issue-fix` (GH_TOKEN
 * only) — promoting them to `agent:fix` always burns a full Claude run that ends
 * `blocked-secrets`. This detector intercepts them PRE-promotion, mirroring
 * `detectWorkflowScoped` (#1724). CONSERVATIVE (bias to promote): only the 3 known
 * monitor-applied labels trigger a park.
 */
import { describe, it, expect } from 'vitest';
import {
  detectSecretsScoped,
  matchSecretsScopedLabel,
  SECRETS_SCOPED_LABELS,
} from '../scripts/lib/secrets-scope-detect.mjs';
import { detectSecretsScoped as reExported } from '../scripts/ci/followup-drainer.mjs';

describe('detectSecretsScoped — scoped (park preemptivo)', () => {
  it('rileva la label cloudflare-5xx (CF 5xx monitor, richiede CF_API_TOKEN)', () => {
    expect(detectSecretsScoped(['priority:medium', 'stability', 'cloudflare-5xx'])).toBe(true);
  });

  it('rileva la label campaign-goal (richiede POSTHOG_PERSONAL_API_KEY)', () => {
    expect(detectSecretsScoped(['seo', 'campaign-goal'])).toBe(true);
  });

  it('rileva la label evergreen-refresh (richiede GEMINI_API_KEY/GH_MODELS_PAT)', () => {
    expect(detectSecretsScoped(['content', 'evergreen-refresh'])).toBe(true);
  });

  it('è re-esportato invariato da followup-drainer.mjs', () => {
    expect(reExported(['cloudflare-5xx'])).toBe(true);
  });
});

describe('detectSecretsScoped — NON scoped (promuovi)', () => {
  it('non scatta senza nessuna delle 3 label note', () => {
    expect(detectSecretsScoped(['follow-up', 'fu-prio:high', 'bug'])).toBe(false);
  });

  it('non scatta su prose/label simili ma non esatte (es. "revenue")', () => {
    expect(detectSecretsScoped(['revenue', 'priority:high'])).toBe(false);
  });

  it('gestisce input vuoto/null/undefined senza throw', () => {
    expect(detectSecretsScoped([])).toBe(false);
    expect(detectSecretsScoped(null as unknown as string[])).toBe(false);
    expect(detectSecretsScoped(undefined as unknown as string[])).toBe(false);
  });
});

describe('matchSecretsScopedLabel', () => {
  it('ritorna label + secret + reason per un match', () => {
    const match = matchSecretsScopedLabel(['stability', 'cloudflare-5xx']);
    expect(match).not.toBeNull();
    expect(match?.label).toBe('cloudflare-5xx');
    expect(match?.secret).toBe('CF_API_TOKEN');
    expect(typeof match?.reason).toBe('string');
  });

  it('ritorna null senza match', () => {
    expect(matchSecretsScopedLabel(['bug', 'priority:high'])).toBeNull();
  });

  it('ogni entry di SECRETS_SCOPED_LABELS ha secret e reason non vuoti', () => {
    for (const [label, meta] of Object.entries(SECRETS_SCOPED_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
      expect(meta.secret.length).toBeGreaterThan(0);
      expect(meta.reason.length).toBeGreaterThan(0);
    }
  });
});
