import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ snapshot: null as any }));
vi.mock('../scripts/assisted-application/lib/portal/fields.mjs', async importOriginal => ({
  ...await importOriginal<any>(), extractFields: vi.fn(async () => state.snapshot), registerPortalChannelType: vi.fn(),
}));
vi.mock('../scripts/assisted-application/lib/portal/plan.mjs', async importOriginal => ({
  ...await importOriginal<any>(), planPage: vi.fn(async () => ({ actions: [], missingRequired: [] })),
}));
vi.mock('../scripts/assisted-application/lib/portal/diagnostics.mjs', async importOriginal => ({
  ...await importOriginal<any>(), startPortalDiagnostics: () => ({ data: {}, currentAttempt: () => 1, installFetchObserver: async () => {},
    beginAttempt: async () => {}, beforeSubmit: async () => {}, finalClick: () => {}, afterSubmit: async () => {}, finish: async () => {} }),
}));
import { submitViaPortal } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { portalProtocolFromHtml } from '../scripts/assisted-application/lib/portal/protocol.mjs';

const title = 'Infrastructure Strategy Manager';
const applyUrl = 'https://careers.example/Careers/ApplicationMethods?jobId=42';
const profileUrl = 'https://careers.example/Careers/ApplicationConfirmation?jobId=42';
const reviewUrl = 'https://careers.example/Careers/ApplicationReview?jobId=42';
const receiptUrl = 'https://careers.example/Careers/ApplicationComplete?jobId=42';
const snapshot = (url: string, text: string, buttons: any[]) => ({ url, title, text: `${title}. ${text}`, fields: [], buttons, errors: [], captcha: false, passwordVisible: false });
const profile = snapshot(profileUrl, 'Since you have already submitted your personal information, the application process will be simpler.', [{ id: 'navigation', text: 'Apply', href: reviewUrl }]);
const review = snapshot(reviewUrl, 'Please review the information below. Once you have reviewed, please select Submit to finalise your application.', [{ id: 'commit', text: 'Apply' }]);
const receipt = snapshot(receiptUrl, 'Thank you for your application.', [{ text: 'My profile' }]);

function fixture(initial = profile, source: any = null, finalReview = review, finalClickError: Error | null = null, options: any = {}) {
  state.snapshot = source || initial;
  const guard = vi.fn(async () => {
    expect(state.snapshot.url).toBe(reviewUrl);
    expect(click).not.toHaveBeenCalled();
  });
  const click = vi.fn(async () => { expect(guard).toHaveBeenCalledTimes(1); state.snapshot = receipt; });
  const openClick = vi.fn(async () => { expect(guard).not.toHaveBeenCalled(); state.snapshot = initial; });
  const page: any = {
    url: () => state.snapshot.url, title: async () => title, frames: () => [page], mainFrame: () => page,
    goto: vi.fn(async (url: string) => {
      if (url === options.applyUrl && options.applySnapshot) state.snapshot = options.applySnapshot;
      if (url === reviewUrl) { expect(guard).not.toHaveBeenCalled(); state.snapshot = finalReview; }
      return { status: () => 200 };
    }),
    evaluate: async (fn: Function) => {
      const source = String(fn);
      if (source.includes('navigator.userAgent')) return 'Chrome';
      return source.includes('document.body') ? state.snapshot.text : false;
    },
    waitForLoadState: async () => {}, waitForTimeout: async () => {}, screenshot: async () => Buffer.from('fixture'),
    getByRole: () => ({
      count: async () => 0,
      filter: () => ({ first: () => ({ waitFor: async () => { throw new Error('not visible'); } }) }),
    }),
    locator: () => ({
      count: async () => 0,
      first: () => ({
        click: () => finalClickError && state.snapshot.url === reviewUrl
          ? Promise.reject(finalClickError)
          : state.snapshot === source ? openClick() : click(),
        evaluate: async (_fn: Function, argument: any) => ({ ok: true, contractJson: JSON.stringify(argument) }),
      }),
    }),
  };
  const browser = { newContext: async () => ({ route: async () => {}, waitForEvent: async () => null, newPage: async () => page, close: async () => {} }), close: async () => {}, version: () => '151' };
  const run = () => submitViaPortal({ applyUrl: source?.url || options.applyUrl || applyUrl, postingUrl: options.postingUrl, channelType: options.channelType,
    job: options.job || { title }, language: 'en', candidate: { identity: {}, profile: {} }, files: {},
    codex: vi.fn(), launch: async () => browser, onBeforeSubmit: guard });
  return { run, guard, click, openClick, page };
}

beforeEach(() => vi.clearAllMocks());
describe('runner final guard across three application stages', () => {
  it('navigates profile → review without a click claim, guards the final Apply once, then confirms this job receipt', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.event).toEqual({ type: 'submit_succeeded', channel: 'portal' });
    expect(f.page.goto).toHaveBeenCalledWith(reviewUrl, { waitUntil: 'domcontentloaded' });
    expect(f.guard).toHaveBeenCalledTimes(1);
    expect(f.click).toHaveBeenCalledTimes(1);
  });

  it('records an already visible same-posting receipt without arming a second submit', async () => {
    const f = fixture({ ...receipt, buttons: [{ text: 'Finish application' }] });
    const result = await f.run();
    expect(result.event).toEqual({ type: 'submit_succeeded', channel: 'portal' });
    expect(result.evidence.finalOutcomes).toEqual(['confirmed']);
    expect(result.evidence.finalUrl).toBe(receiptUrl);
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('does not click an account confirmation whose owned review destination is absent', async () => {
    const f = fixture({ ...profile, buttons: [{ id: 'unknown', text: 'Apply' }] });
    const result = await f.run();
    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'application_stage_unknown' });
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('opens a same-ID SuccessFactors apply URL from a warmed posting when the shell has no apply control', async () => {
    const postingUrl = 'https://jobs.stadt-zuerich.ch/job/Application-Manager/1373719857/';
    const cityApplyUrl = 'https://jobs.stadt-zuerich.ch/talentcommunity/apply/1373719857/?locale=de_DE';
    const shell = { ...snapshot(postingUrl, 'Sprache', [{ id: 'language', text: 'Sprache', chrome: true }]) };
    const registration = {
      ...snapshot(cityApplyUrl, 'Create your account for Application Manager', [{ id: 'create', text: 'Bewerbungskonto erstellen' }]),
      fields: [
        { id: 'email', label: 'E-Mail-Adresse', kind: 'text', inputType: 'email', required: true },
        { id: 'password', label: 'Passwort', kind: 'text', inputType: 'password', required: true },
      ],
      passwordVisible: true,
    };
    const f = fixture(shell, null, review, null, {
      applyUrl: cityApplyUrl,
      postingUrl,
      channelType: 'employer_site',
      job: { company: 'Stadt Zürich', title: 'Application Manager' },
      applySnapshot: registration,
    });

    const result = await f.run();

    expect(f.page.goto).toHaveBeenCalledWith(cityApplyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    expect(result.event).toMatchObject({ type: 'submit_handoff' });
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('stops if the verified SuccessFactors apply route redirects away from the posting ID', async () => {
    const postingUrl = 'https://jobs.stadt-zuerich.ch/job/Application-Manager/1373719857/';
    const cityApplyUrl = 'https://jobs.stadt-zuerich.ch/talentcommunity/apply/1373719857/?locale=de_DE';
    const shell = { ...snapshot(postingUrl, 'Sprache', [{ id: 'language', text: 'Sprache', chrome: true }]) };
    const genericLanding = snapshot('https://jobs.stadt-zuerich.ch/de/jobs.html', 'Job search', [{ id: 'language', text: 'Sprache', chrome: true }]);
    const f = fixture(shell, null, review, null, {
      applyUrl: cityApplyUrl,
      postingUrl,
      channelType: 'employer_site',
      job: { company: 'Stadt Zürich', title: 'Application Manager' },
      applySnapshot: genericLanding,
    });

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'posting_mismatch' });
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('hands off an exhausted pre-dispatch intermediate click with encrypted diagnostic evidence', async () => {
    state.snapshot = snapshot(applyUrl, 'Application step. Continue to the next part of the form.', [
      { id: 'step-next', text: 'Continue', formId: 'application', frame: 0, disabled: false },
    ]);
    state.snapshot.fields = [{ id: 'cv', kind: 'file', inputType: 'file', label: 'CV', required: false, formId: 'application', frame: 0 }];
    const clickTimeout = Object.assign(new Error('Timeout 6000ms exceeded waiting for locator'), {
      code: 'locator.click: Timeout 6000ms exceeded',
    });
    const candidates = { count: async () => 0, nth: () => null };
    const page: any = {
      url: () => state.snapshot.url,
      title: async () => title,
      frames: () => [page],
      mainFrame: () => page,
      goto: vi.fn(async () => ({ status: () => 200 })),
      evaluate: async (fn: Function) => {
        const source = String(fn);
        if (source.includes('navigator.userAgent')) return 'Chrome';
        if (source.includes('document.body')) return state.snapshot.text;
        return false;
      },
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      screenshot: async () => Buffer.from('fixture'),
      locator: vi.fn(() => ({
        count: async () => 0,
        nth: () => ({ click: vi.fn().mockRejectedValue(clickTimeout) }),
        first: () => ({ click: vi.fn().mockRejectedValue(clickTimeout) }),
      })),
      getByRole: vi.fn(() => candidates),
    };
    const context: any = { route: async () => {}, waitForEvent: async () => null, newPage: async () => page, close: async () => {} };
    const browser = { newContext: async () => context, close: async () => {}, version: () => '151' };

    const result = await submitViaPortal({
      applyUrl, job: { title }, language: 'en', candidate: { identity: {}, profile: {} }, files: {},
      skipPostingCheck: true, maxSteps: 2, codex: vi.fn(), launch: async () => browser,
    });

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'portal_control_click_unresolved' });
    expect(result.evidence.controlClickFailure).toEqual({ stage: 'intermediate', outcome: 'pre_dispatch' });
    expect(result.evidence.stopReport.reason).toBe('portal_control_click_unresolved');
    expect(result.evidence.finalOutcomes).toBeUndefined();
  });

  it('stops on an explicit posting region restriction before clicking its Apply control', async () => {
    const blockedPosting = snapshot(applyUrl,
      'Leider können wir Bewerbungen aus Ihrer Region aktuell nicht unterstützen.',
      [{ id: 'apply', text: 'Jetzt bewerben', href: '', disabled: false }]);
    const f = fixture(blockedPosting);

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'application_region_unsupported' });
    expect(f.openClick).not.toHaveBeenCalled();
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('hands off a proven pre-dispatch timeout from the agent-named advance locator', async () => {
    state.snapshot = snapshot(applyUrl, 'Application step. Continue to the next part of the form.', []);
    state.snapshot.fields = [{ id: 'cv', kind: 'file', inputType: 'file', label: 'CV', required: false, formId: 'application', frame: 0 }];
    const clickTimeout = Object.assign(new Error('Timeout 6000ms exceeded waiting for locator'), {
      code: 'locator.click: Timeout 6000ms exceeded',
    });
    const advanceClick = vi.fn().mockRejectedValue(clickTimeout);
    const advanceLocator = {
      evaluate: async () => ({ button: true, leaves: false, name: 'Continue' }),
      isEnabled: async () => true,
      click: advanceClick,
    };
    const emptyLocator = { count: async () => 0, nth: () => ({}), first: () => ({}) };
    const page: any = {
      url: () => state.snapshot.url,
      title: async () => title,
      frames: () => [page],
      mainFrame: () => page,
      ariaSnapshot: async () => '- button "Continue" [ref=e0]',
      goto: vi.fn(async () => ({ status: () => 200 })),
      evaluate: async (fn: Function) => {
        const source = String(fn);
        if (source.includes('navigator.userAgent')) return 'Chrome';
        if (source.includes('document.body')) return state.snapshot.text;
        return false;
      },
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      screenshot: async () => Buffer.from('fixture'),
      locator: vi.fn((selector: string) => selector === 'aria-ref=e0' ? advanceLocator : emptyLocator),
    };
    const context: any = { route: async () => {}, waitForEvent: async () => null, newPage: async () => page, close: async () => {} };
    const browser = { newContext: async () => context, close: async () => {}, version: () => '151' };
    const codex = vi.fn(async () => ({ status: 'done', reason: 'test', actions: [], advanceRef: 'e0', submitRef: '', questions: [] }));

    const result = await submitViaPortal({
      applyUrl, job: { title }, language: 'en', candidate: { identity: {}, profile: {} }, files: {},
      skipPostingCheck: true, maxSteps: 2, codex, launch: async () => browser,
    });

    expect(advanceClick).toHaveBeenCalledOnce();
    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'portal_control_click_unresolved' });
    expect(result.evidence.controlClickFailure).toEqual({ stage: 'intermediate', outcome: 'pre_dispatch' });
    expect(result.evidence.stopReport.reason).toBe('portal_control_click_unresolved');
    expect(result.evidence.finalOutcomes).toBeUndefined();
  });

  it('does not reclassify an exhausted final submit click as an intermediate handoff', async () => {
    const clickTimeout = Object.assign(new Error('Timeout 6000ms exceeded waiting for locator'), {
      code: 'locator.click: Timeout 6000ms exceeded',
    });
    const finalReview = {
      ...review,
      buttons: [{ id: 'commit', text: 'Apply', formId: 'application', frame: 0, disabled: false }],
    };
    const f = fixture(profile, null, finalReview, clickTimeout);

    await expect(f.run()).rejects.toMatchObject({ code: 'portal_control_click_unresolved' });
    expect(f.guard).toHaveBeenCalledOnce();
    expect(f.click).not.toHaveBeenCalled();
  });

  it.each(['ApplicationSave/ApplicationReview', 'Unknown/ApplicationReview', 'Save/application/review'])('never navigates an owned review suffix beneath an unproved parent: %s', async path => {
    const target = `https://careers.example/Careers/${path}?jobId=42`;
    const f = fixture({ ...profile, buttons: [{ id: 'navigation', text: 'Apply', href: target }] });
    const result = await f.run();
    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'application_stage_unknown' });
    expect(f.page.goto).not.toHaveBeenCalledWith(target, expect.anything());
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('uses captured protocol for a slug/path posting and guards only the review commit', async () => {
    const postingUrl = 'https://careers.example/Careers/JobDetail/Infrastructure-Strategy-Manager/42';
    const markup = (page: string) => `<meta name="avature.portal.id" content="87"><meta name="avature.portal.urlPath" content="Careers"><meta name="avature.portal.page" content="${page}"><portal-data id="synapserBootstrap" data-applicationName="customPortal" data-applicationCode="customPortal_87"></portal-data>`;
    const source = { ...snapshot(postingUrl, 'Read this vacancy and apply.', [{ id: 'open', text: 'Apply' }]), protocol: await portalProtocolFromHtml(markup('JobDetail'), postingUrl) };
    const first = { ...profile, protocol: await portalProtocolFromHtml(markup('ApplicationConfirmation'), profileUrl) };
    const final = { ...review, protocol: await portalProtocolFromHtml(markup('ApplicationReview'), reviewUrl) };
    const f = fixture(first, source, final);
    const result = await f.run();
    expect(result.event).toEqual({ type: 'submit_succeeded', channel: 'portal' });
    expect(f.openClick).toHaveBeenCalledOnce();
    expect(f.page.goto).toHaveBeenCalledWith(reviewUrl, { waitUntil: 'domcontentloaded' });
    expect(f.guard).toHaveBeenCalledOnce();
    expect(f.click).toHaveBeenCalledOnce();
  });

  it('hands off a public gallery reached after an application step before agent fallback', async () => {
    const initial = snapshot(applyUrl, 'Application step.', [{ id: 'step-next', text: 'Next' }]);
    initial.fields = [{ id: 'application-note', kind: 'text', inputType: 'text', label: 'Application note', required: false, formId: 'application', frame: 0 }];
    const gallery = snapshot(`${applyUrl}/bewerbungstipps/`, 'Public content.', [
      { text: 'Menü', chrome: true },
      { text: 'Mein Konto', chrome: true },
      { text: 'Vorheriges', formId: 'public-gallery', frame: 0, disabled: false },
      { text: 'Nächstes', formId: 'public-gallery', frame: 0, disabled: false },
      { text: 'Öffne Bild in Grossansicht', formId: 'public-gallery', frame: 0, disabled: false },
      { text: 'Seite drucken', formId: 'public-gallery', frame: 0, disabled: false },
    ]);
    gallery.fields = [{
      id: 'attachment', kind: 'file', inputType: 'file',
      label: 'Eine oder mehrere Dateien auswählen (optional) (optional).', required: false,
      formId: 'public-gallery', frame: 0,
    }];
    state.snapshot = initial;
    const advance = vi.fn(async () => { state.snapshot = gallery; });
    const codex = vi.fn(async () => { throw new Error('public gallery must not reach the agent'); });
    const page: any = {
      frames: () => [page], mainFrame: () => page,
      url: () => state.snapshot.url,
      title: async () => title,
      evaluate: async (fn: Function) => {
        const source = String(fn);
        if (source.includes('navigator.userAgent')) return 'Chrome';
        if (source.includes('document.body')) return state.snapshot.text;
        return false;
      },
      goto: vi.fn(async () => ({ status: () => 200 })),
      waitForLoadState: async () => {}, waitForTimeout: async () => {},
      screenshot: async () => Buffer.from('fixture'),
      locator: () => ({ count: async () => 0, nth: () => ({ click: advance }), first: () => ({ click: advance }) }),
      getByRole: () => ({ filter: () => ({ first: () => ({ waitFor: async () => { throw new Error('not found'); } }) }) }),
    };
    const context: any = {
      route: async () => {}, waitForEvent: async () => null,
      newPage: async () => page, close: async () => {},
    };
    const browser = { newContext: async () => context, close: async () => {}, version: () => '151' };

    const result = await submitViaPortal({
      applyUrl, job: { title }, language: 'en', candidate: { identity: {}, profile: {} }, files: {},
      skipPostingCheck: true, maxSteps: 3, codex, launch: async () => browser,
    });

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'posting_mismatch' });
    expect(advance).toHaveBeenCalledOnce();
    expect(codex).not.toHaveBeenCalled();
  });
});
