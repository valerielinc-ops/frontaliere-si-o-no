import { describe, expect, it } from 'vitest';
import {
  formPostingMatch,
  namesAnotherEmployer,
  recoverAccountPassword,
} from '../scripts/assisted-application/lib/portal/portal.mjs';

// Synthetic Avature-shaped posting page: site header, the role heading, a "Basic information" block of field
// labels and a contact paragraph. The employer is named in the header only.
const job = { company: 'Example Advisory AG', title: 'Senior Example Role' };
const url = 'https://careers.example.test/ExampleCareers/JobDetail/Senior-Example-Role/4711';
const posting = (contact: string) => [
  'Senior Example Role - 4711',
  'Skip to content', 'Example Advisory', 'Menu', 'Search jobs', 'Why join Example Advisory?', 'Recruitment agencies', 'Login',
  'Senior Example Role',
  'Basic information', 'Business line', 'Technology', 'City', 'Geneva, Zurich', 'Experience level', 'Experienced',
  'Date published', '13-Jul-2026', 'Req #', '4711', 'Job description',
  contact,
].join('\n');

describe('an e-mail address is a contact, not another employer', () => {
  const withMail = posting('If you have any questions, please contact Pat at talent@example-advisory.ch.');

  it('does not read the local part next to the employer word as a name', () => {
    expect(namesAnotherEmployer(withMail, job, { allowPostingLocation: true })).toBe(false);
  });

  it('binds the posting page to the order when its only conflict was the contact address', () => {
    const diagnostics: Record<string, unknown> = {};
    const result = formPostingMatch(`${withMail}\n${url}`, job, {
      pageUrl: url, postingUrl: url, applyUrl: url, diagnostics,
    });
    expect(result).toBe('match');
    expect(diagnostics.guard).toBeUndefined();
  });

  it('still reads a written name next to the employer as another employer', () => {
    expect(namesAnotherEmployer(posting('Other Example Advisory'), job, { allowPostingLocation: true })).toBe(true);
  });
});

describe('a mismatch with no other guard says so in the diagnostics', () => {
  it('names direct_unbound_mismatch when the page shows the role but never the employer', () => {
    const diagnostics: Record<string, unknown> = {};
    const text = 'Senior Example Role\nBasic information\nReq # 4711\nJob description\n' + url;
    expect(formPostingMatch(text, job, { pageUrl: url, postingUrl: url, applyUrl: url, diagnostics })).toBe('mismatch');
    expect(diagnostics.guard).toBe('direct_unbound_mismatch');
  });
});

describe('password recovery stops name the step they stopped at', () => {
  it('reports reset_route_unopened when no verified «Forgot password» route exists on the sign-in page', async () => {
    const loginUrl = 'https://careers.example.test/ExampleCareers/Login';
    const recoveryAttempts = new Set<string>();
    const result = await recoverAccountPassword({
      page: { url: () => loginUrl, frames: () => [], mainFrame: () => ({}), waitForTimeout: async () => {} } as any,
      snapshot: {
        url: loginUrl,
        fields: [
          { id: 'a', inputType: 'email', label: 'Username', frame: 0 },
          { id: 'b', inputType: 'password', label: 'Password', frame: 0 },
        ],
        buttons: [], links: [], dialogs: [],
      } as any,
      ctx: {
        candidate: { identity: { email: 'pat.example.ab2c@candidature.frontaliereticino.ch' } },
        dryRun: false,
        accounts: { beginRecovery: async () => ({ status: 'started' }), waitForPasswordReset: async () => null, load: async () => null },
      } as any,
      host: 'careers.example.test',
      account: { status: 'created', email: 'pat.example.ab2c@candidature.frontaliereticino.ch' } as any,
      diagnostics: null,
      typedSecrets: new Set<string>(),
      registrationRestarts: new Map(),
      recoveryAttempts,
    } as any);
    expect(result).toMatchObject({
      handoff: 'account_recovery_rejected',
      accountFailure: { code: 'account_recovery_rejected', stage: 'login' },
      recoveryStep: 'reset_route_unopened',
    });
  });
});
