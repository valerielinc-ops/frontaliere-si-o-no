import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string): string => readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('shared save/follow signup funnel', () => {
  it('keeps Google, LinkedIn, email, and the disclosure in one modal', () => {
    const prompt = read('components/community/SignupPromptModal.tsx');

    expect(prompt).toContain('<SocialSignInButtons');
    expect(prompt).toContain('<EmailInput');
    expect(prompt).toContain('<EmailConsentCheckbox');
    expect(prompt).toContain("intent === 'follow'");
    expect(prompt).toContain('upsertUnifiedEmailSubscriber');
    expect(prompt).toContain("requestConfirmationEmail(trimmed, 'login')");
  });

  it('routes save and follow through the same modal without an inline follow field', () => {
    const save = read('components/community/SaveSignInPromptModal.tsx');
    const follow = read('components/community/CompanyFollowButton.tsx');
    const board = read('components/community/JobBoard.tsx');

    expect(save).toContain('intent="save"');
    expect(follow).toContain('<SignupPromptModal');
    expect(follow).toContain('intent="follow"');
    expect(follow).not.toContain('<EmailInput');
    expect(follow).not.toContain('company-follow-email');
    expect(board).toContain("onClick={() => handleToggleSave(selectedJob, 'detail_gate')}");
    expect(board).toContain("onClick={() => handleToggleSave(selectedJob, 'detail')}");
    expect((board.match(/\{saveAuthPromptJsx\}/g) || []).length).toBe(3);
  });

  it('ships follow-specific copy in all four locales', () => {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const source = read(`services/locales/${locale}-core.ts`);
      expect(source).toContain("'jobAlert.companyFollow.authPrompt.title'");
      expect(source).toContain("'jobAlert.companyFollow.authPrompt.body'");
      expect(source).toContain("'jobAlert.companyFollow.authPrompt.checkEmailBody'");
    }
  });
});
