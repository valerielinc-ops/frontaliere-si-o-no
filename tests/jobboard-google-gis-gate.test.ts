import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('JobBoard Google gate uses GIS as primary path', () => {
  it('wires the job gate to the Google Identity Services button and receives the auth user for post-login completion', () => {
    const jobBoardSource = readFileSync(resolve(root, 'components/community/JobBoard.tsx'), 'utf8');
    const appSource = readFileSync(resolve(root, 'App.tsx'), 'utf8');

    expect(jobBoardSource).toContain("renderGoogleButton");
    expect(jobBoardSource).toContain("getAuthEmail");
    expect(jobBoardSource).toContain("const modalGoogleButtonRef = useRef<HTMLDivElement | null>(null);");
    expect(jobBoardSource).toContain("const inlineGoogleButtonRef = useRef<HTMLDivElement | null>(null);");
    expect(jobBoardSource).toContain("await renderGoogleButton(buttonContainer, {");
    expect(jobBoardSource).toContain("const userEmail = getAuthEmail(authUser);");
    expect(jobBoardSource).toContain("if (!authResolved || !isLoggedIn) return;");
    expect(appSource).toContain("authUser={authUser}");
  });

  it('uses the provider email fallback for every job-alert gate on the board', () => {
    const jobBoardSource = readFileSync(resolve(root, 'components/community/JobBoard.tsx'), 'utf8');
    const alertBlockStart = jobBoardSource.indexOf('// Job-detail alert prompt — gating + 1.5 s reveal timer.');
    const alertBlock = jobBoardSource.slice(alertBlockStart);

    expect(alertBlock).toContain('const userEmail = getAuthEmail(authUser);');
    expect(alertBlock).not.toContain('const userEmail = authUser?.email || null;');
  });
});
