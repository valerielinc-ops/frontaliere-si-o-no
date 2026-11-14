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
import { advancedToFinalReview, submitViaPortal } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { portalProtocolFromHtml } from '../scripts/assisted-application/lib/portal/protocol.mjs';

const title = 'Infrastructure Strategy Manager';
const applyUrl = 'https://careers.example/Careers/ApplicationMethods?jobId=42';
const profileUrl = 'https://careers.example/Careers/ApplicationConfirmation?jobId=42';
const reviewUrl = 'https://careers.example/Careers/ApplicationReview?jobId=42';
const receiptUrl = 'https://careers.example/Careers/ApplicationComplete?jobId=42';
const snapshot = (url: string, text: string, buttons: any[]) => ({ url, title, heading: title, text: `${title}. ${text}`, fields: [], buttons, errors: [], captcha: false, passwordVisible: false });
const profile = snapshot(profileUrl, 'Since you have already submitted your personal information, the application process will be simpler.', [{ id: 'navigation', text: 'Apply', href: reviewUrl }]);
const review = snapshot(reviewUrl, 'Please review the information below. Once you have reviewed, please select Submit to finalise your application.', [{ id: 'commit', text: 'Apply' }]);
const receipt = snapshot(receiptUrl, 'Thank you for your application.', [{ text: 'My profile' }]);

function fixture(initial = profile, source: any = null, finalReview = review, finalClickError: Error | null = null, options: any = {}) {
  state.snapshot = source || initial;
  const buttonTransitions = options.buttonTransitions || {};
  const guard = vi.fn(async () => {
    expect(state.snapshot.url).toBe(reviewUrl);
    expect(click).not.toHaveBeenCalled();
  });
  const click = vi.fn(async () => { expect(guard).toHaveBeenCalledTimes(1); state.snapshot = receipt; });
  const openClick = vi.fn(async () => { expect(guard).not.toHaveBeenCalled(); state.snapshot = initial; });
  const page: any = {
    url: () => state.snapshot.url, title: async () => state.snapshot.title || title, frames: () => [page], mainFrame: () => page,
    goto: vi.fn(async (url: string) => {
      if (url === options.applyUrl && options.applySnapshot) state.snapshot = options.applySnapshot;
      if (url === reviewUrl) { expect(guard).not.toHaveBeenCalled(); state.snapshot = finalReview; }
      return { status: () => 200 };
    }),
    evaluate: async (fn: Function) => {
      const source = String(fn);
      if (source.includes('navigator.userAgent')) return 'Chrome';
      if (source.includes("querySelectorAll('h1,")) {
        if (Object.prototype.hasOwnProperty.call(options, 'pageHeadings')) return options.pageHeadings;
        if (options.pageHeading) return [options.pageHeading];
        return state.snapshot.heading ? [state.snapshot.heading] : [];
      }
      return source.includes('document.body') ? state.snapshot.text : false;
    },
    ...(options.agentSnapshot ? { ariaSnapshot: async () => options.agentSnapshot(state.snapshot) } : {}),
    waitForLoadState: async () => {}, waitForTimeout: async () => {}, screenshot: async () => Buffer.from('fixture'),
    getByRole: () => ({
      count: async () => 0,
      filter: () => ({ first: () => ({ waitFor: async () => { throw new Error('not visible'); } }) }),
    }),
    locator: (selector: string) => {
      const ref = /^aria-ref=(e\d+)$/.exec(selector)?.[1] || '';
      const agentControl = ref ? options.agentControl?.(state.snapshot, ref) : null;
      if (agentControl) {
        return {
          evaluate: async (fn: Function) => fn.name === 'allowAgentApplicationEntryClickInPage' ? true : agentControl.info,
          isEnabled: async () => !agentControl.info.disabled,
          click: async () => {
            const transition = buttonTransitions[agentControl.selector];
            if (transition) return transition();
            return state.snapshot === source ? openClick() : click();
          },
        };
      }
      return {
        count: async () => 0,
        first: () => ({
          click: (_options?: unknown) => {
            const transition = buttonTransitions[selector];
            if (transition) return transition();
            return finalClickError && state.snapshot.url === reviewUrl
              ? Promise.reject(finalClickError)
              : state.snapshot === source ? openClick() : click();
          },
          evaluate: async (_fn: Function, argument: any) => ({ ok: true, contractJson: JSON.stringify(argument) }),
        }),
      };
    },
  };
  const browser = { newContext: async () => ({ route: async () => {}, waitForEvent: async () => null, newPage: async () => page, close: async () => {} }), close: async () => {}, version: () => '151' };
  const codex = vi.fn();
  const run = () => submitViaPortal({ applyUrl: source?.url || options.applyUrl || applyUrl, postingUrl: options.postingUrl, channelType: options.channelType,
    postingRouteProof: options.postingRouteProof,
    job: options.job || { title }, language: 'en', candidate: { identity: {}, profile: {} }, files: {},
    codex, launch: async () => browser, onBeforeSubmit: guard });
  return { run, guard, click, openClick, page, codex };
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

  it('opens a source-proven SuccessFactors module from a language-only posting shell', async () => {
    const postingUrl = 'https://careers.helsana.ch/job/it-management-assistenz/1426391333/';
    const moduleUrl = 'https://career5.successfactors.eu/career?company=Helsana&career_job_req_id=34525&lang=de_DE&career_ns=job_application';
    const postingRouteProof = { via: 'successfactors', applyUrl: moduleUrl, postingUrl };
    const shell = snapshot(postingUrl, 'Helsana careers', [{ id: 'language', text: 'Sprache', chrome: true }]);
    const registration = {
      ...snapshot(moduleUrl, 'Create your account for Infrastructure Strategy Manager', [{ id: 'create', text: 'Bewerbungskonto erstellen' }]),
      fields: [
        { id: 'email', label: 'E-Mail-Adresse', kind: 'text', inputType: 'email', required: true },
        { id: 'first-name', label: 'Vorname', kind: 'text', required: true },
        { id: 'last-name', label: 'Nachname', kind: 'text', required: true },
      ],
    };
    const f = fixture(shell, null, review, null, {
      applyUrl: moduleUrl,
      postingUrl,
      postingRouteProof,
      applySnapshot: registration,
      channelType: 'successfactors',
      job: { company: 'Helsana', title },
    });

    const result = await f.run();

    expect(f.page.goto).toHaveBeenCalledWith(postingUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    expect(f.page.goto).toHaveBeenCalledWith(moduleUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    expect(result.event).toMatchObject({ type: 'submit_handoff' });
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
    expect(f.openClick).not.toHaveBeenCalled();
  });

  it('clicks one duplicated custom-domain Postuler entry and continues to the bound SuccessFactors sign-in', async () => {
    const applyUrl = 'https://career55.sapsf.eu/career?company=Fixture&career_job_req_id=77123&career_ns=job_application';
    const postingUrl = 'https://jobs.fictional-employer.test/job/customer-success-manager/990021/';
    const postingRouteProof = { via: 'successfactors', applyUrl, postingUrl };
    const vacancyContext = 'Fictional Employer GmbH\nCustomer Success Manager';
    const posting = snapshot(postingUrl, 'Fictional Employer GmbH · Customer Success Manager · Rechercher les offres', [
      { id: 'apply-top', text: 'Postuler »»', vacancyContext, chrome: true },
      { id: 'apply-bottom', text: 'Postuler »»', vacancyContext, chrome: true },
      { id: 'alert', text: 'Créer une alerte', chrome: true },
      { id: 'profile', text: 'Mon profil de candidature', chrome: true },
    ]);
    const signInUrl = applyUrl;
    const signIn = {
      ...snapshot(signInUrl, 'Sign in to continue your application', [{ id: 'sign-in', text: 'Sign in' }]),
      fields: [
        { id: 'email', label: 'Email address', kind: 'text', inputType: 'email', required: true },
        { id: 'password', label: 'Password', kind: 'text', inputType: 'password', required: true },
      ],
      passwordVisible: true,
    };
    const pressed: string[] = [];
    const f = fixture(posting, null, review, null, {
      applyUrl,
      postingUrl,
      postingRouteProof,
      channelType: 'successfactors',
      job: { company: 'Fictional Employer GmbH', title: 'Customer Success Manager' },
      applySnapshot: posting,
      buttonTransitions: {
        '[data-aa-id="apply-top"]': async () => { pressed.push('apply-top'); state.snapshot = signIn; },
        '[data-aa-id="apply-bottom"]': async () => { pressed.push('apply-bottom'); state.snapshot = signIn; },
      },
    });

    const result = await f.run();

    expect(pressed).toEqual(['apply-top']);
    expect(result.event).toMatchObject({ type: 'submit_handoff' });
    expect(result.event.reason).not.toBe('application_stage_unknown');
    expect(state.snapshot.url).toBe(signInUrl);
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('does not click the duplicate custom-domain CTA when the first click leaves the posting unchanged', async () => {
    const applyUrl = 'https://career55.sapsf.eu/career?company=Fixture&career_job_req_id=77123&career_ns=job_application';
    const postingUrl = 'https://jobs.fictional-employer.test/job/customer-success-manager/990021/';
    const postingRouteProof = { via: 'successfactors', applyUrl, postingUrl };
    const vacancyContext = 'Fictional Employer GmbH\nCustomer Success Manager';
    const posting = snapshot(postingUrl, 'Fictional Employer GmbH · Customer Success Manager', [
      { id: 'apply-top', text: 'Postuler »»', vacancyContext, chrome: true },
      { id: 'apply-bottom', text: 'Postuler »»', vacancyContext, chrome: true },
      { id: 'alert', text: 'Créer une alerte', chrome: true },
      { id: 'profile', text: 'Mon profil de candidature', chrome: true },
    ]);
    const pressed: string[] = [];
    const f = fixture(posting, null, review, null, {
      applyUrl,
      postingUrl,
      postingRouteProof,
      channelType: 'successfactors',
      job: { company: 'Fictional Employer GmbH', title: 'Customer Success Manager' },
      applySnapshot: posting,
      buttonTransitions: {
        '[data-aa-id="apply-top"]': async () => { pressed.push('apply-top'); },
        '[data-aa-id="apply-bottom"]': async () => { pressed.push('apply-bottom'); },
      },
    });

    const result = await f.run();

    expect(pressed).toEqual(['apply-top']);
    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'posting_mismatch' });
    expect(f.codex).not.toHaveBeenCalled();
    expect(f.guard).not.toHaveBeenCalled();
  });

  it('opens a Career Site Builder Apply dropdown and its own menu entry instead of stopping as an unknown stage', async () => {
    // Synthetic shape of order s2Tbwwjd's posting: two identical «Jetzt
    // bewerben» disclosure toggles, a menu with the manual entry and LinkedIn.
    const postingUrl = 'https://careers.helsana.ch/job/Synthetic-Role/123/';
    const signInUrl = 'https://career5.successfactors.eu/careers?company=synthetic';
    const context = `${title} · Jetzt bewerben`;
    const toggles = [
      { id: 'toggle-top', text: 'Jetzt bewerben', popup: true, section: title, context },
      { id: 'toggle-bottom', text: 'Jetzt bewerben', popup: true, section: title, context },
    ];
    const posting = snapshot(postingUrl, 'Helsana careers', toggles);
    const menu = {
      ...posting,
      buttons: [toggles[0],
        { id: 'manual', text: 'Jetzt bewerben', menuItem: true, href: `${postingUrl}#`, section: title, context: title },
        { id: 'linkedin', text: 'Apply with LinkedIn', menuItem: true, href: `${postingUrl}#`, section: title, context: title },
        toggles[1]],
    };
    const signIn = {
      ...snapshot(signInUrl, 'Anmelden', [{ id: 'sign-in', text: 'Anmelden' }]),
      fields: [
        { id: 'email', label: 'E-Mail-Adresse:*', kind: 'text', inputType: 'text', required: true },
        { id: 'password', label: 'Kennwort:*', kind: 'text', inputType: 'password', required: true },
      ],
      passwordVisible: true,
    };
    const pressed: string[] = [];
    const agentPages = new Map([
      [postingUrl, [toggles[0]]],
      [postingUrl + '#menu', menu.buttons],
      [signInUrl, signIn.buttons],
    ]);
    const action = (ref: string) => ({
      ref, action: 'click', value: '', document: 'none', question: '', context: '', answer: '', source: 'widget', evidence: '',
    });
    const f = fixture(posting, null, review, null, {
      applyUrl: postingUrl,
      postingUrl,
      channelType: 'employer_site',
      job: { company: 'Helsana', title },
      agentSnapshot: (current: any) => {
        if (current === posting) return '- button "Jetzt bewerben" [ref=e0]';
        if (current === menu) return menu.buttons.map((button, index) => `- button "${button.text}" [ref=e${index}]`).join('\n');
        return '- textbox "E-Mail-Adresse" [ref=e0]\n- textbox "Kennwort" [ref=e1]';
      },
      agentControl: (current: any, ref: string) => {
        const index = Number(ref.slice(1));
        const controls = current === posting ? agentPages.get(postingUrl)! : current === menu ? agentPages.get(postingUrl + '#menu')! : [];
        const control = controls[index];
        if (!control) return null;
        return {
          selector: `[data-aa-id="${control.id}"]`,
          info: { name: control.text, labelName: '', otp: false, button: true, tag: 'button', inputType: 'button',
            editable: false, inList: false, inForm: false, href: control.href || '', submits: false,
            authForm: false, leaves: Boolean(control.href && !control.href.startsWith('#')), disabled: false },
        };
      },
      buttonTransitions: {
        '[data-aa-id="toggle-top"]': async () => { pressed.push('toggle-top'); state.snapshot = menu; },
        '[data-aa-id="manual"]': async () => { pressed.push('manual'); state.snapshot = signIn; },
        '[data-aa-id="linkedin"]': async () => { pressed.push('linkedin'); },
        '[data-aa-id="toggle-bottom"]': async () => { pressed.push('toggle-bottom'); },
      },
    });
    f.codex
      .mockResolvedValueOnce({ status: 'ACT', reason: '', actions: [action('e0')], advanceRef: '', submitRef: '', questions: [] })
      .mockResolvedValueOnce({ status: 'ACT', reason: '', actions: [action('e1')], advanceRef: '', submitRef: '', questions: [] })
      .mockResolvedValueOnce({ status: 'ACCOUNT_STEP', reason: '', actions: [], advanceRef: '', submitRef: '', questions: [] });

    const result = await f.run();

    expect(pressed.slice(0, 2)).toEqual(['toggle-top', 'manual']);
    expect(pressed).not.toContain('linkedin');
    // The paid listing and its single manual menu item are resolved by the
    // deterministic entry path. The missing account credentials are handed to
    // the existing auth flow without asking the model to invent them.
    expect(f.codex).not.toHaveBeenCalled();
    expect(result.event.type).toBe('submit_handoff');
    expect(state.snapshot.url).toBe(signInUrl);
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('keeps a source-proven SuccessFactors module ahead of a Career Site Builder Apply dropdown', async () => {
    const postingUrl = 'https://careers.helsana.ch/job/it-management-assistenz/1426391333/';
    const moduleUrl = 'https://career5.successfactors.eu/career?company=Helsana&career_job_req_id=34525&lang=de_DE&career_ns=job_application';
    const postingRouteProof = { via: 'successfactors', applyUrl: moduleUrl, postingUrl };
    const context = `${title} · Jetzt bewerben`;
    const shell = snapshot(postingUrl, 'Helsana careers', [
      { id: 'toggle-top', text: 'Jetzt bewerben', popup: true, section: title, context },
      { id: 'toggle-bottom', text: 'Jetzt bewerben', popup: true, section: title, context },
    ]);
    const registration = {
      ...snapshot(moduleUrl, 'Create your account for Infrastructure Strategy Manager', [{ id: 'create', text: 'Bewerbungskonto erstellen' }]),
      fields: [
        { id: 'email', label: 'E-Mail-Adresse', kind: 'text', inputType: 'email', required: true },
        { id: 'first-name', label: 'Vorname', kind: 'text', required: true },
        { id: 'last-name', label: 'Nachname', kind: 'text', required: true },
      ],
    };
    const pressed: string[] = [];
    const f = fixture(shell, null, review, null, {
      applyUrl: moduleUrl,
      postingUrl,
      postingRouteProof,
      applySnapshot: registration,
      channelType: 'successfactors',
      job: { company: 'Helsana', title },
      buttonTransitions: {
        '[data-aa-id="toggle-top"]': async () => { pressed.push('toggle-top'); },
        '[data-aa-id="toggle-bottom"]': async () => { pressed.push('toggle-bottom'); },
      },
    });

    const result = await f.run();

    expect(f.page.goto).toHaveBeenCalledWith(moduleUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    expect(pressed).toEqual([]);
    expect(result.event).toMatchObject({ type: 'submit_handoff' });
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('rejects a unique external Apply control that conflicts with the posting proof', async () => {
    const postingUrl = 'https://careers.helsana.ch/job/it-management-assistenz/1426391333/';
    const moduleUrl = 'https://career5.successfactors.eu/career?company=Helsana&career_job_req_id=34525&lang=de_DE&career_ns=job_application';
    const otherModuleUrl = 'https://career5.successfactors.eu/career?company=Helsana&career_job_req_id=34526&lang=de_DE&career_ns=job_application';
    const postingRouteProof = { via: 'successfactors', applyUrl: moduleUrl, postingUrl };
    const shell = snapshot(postingUrl, 'Helsana careers', [{ id: 'wrong-apply', text: 'Jetzt bewerben', href: otherModuleUrl }]);
    const registration = {
      ...snapshot(moduleUrl, 'Create your account for Infrastructure Strategy Manager', [{ id: 'create', text: 'Bewerbungskonto erstellen' }]),
      fields: [
        { id: 'email', label: 'E-Mail-Adresse', kind: 'text', inputType: 'email', required: true },
        { id: 'first-name', label: 'Vorname', kind: 'text', required: true },
        { id: 'last-name', label: 'Nachname', kind: 'text', required: true },
      ],
    };
    const f = fixture(shell, null, review, null, {
      applyUrl: moduleUrl,
      postingUrl,
      postingRouteProof,
      applySnapshot: registration,
      channelType: 'successfactors',
      job: { company: 'Helsana', title },
    });

    const result = await f.run();

    expect(f.page.goto).toHaveBeenCalledWith(moduleUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    expect(f.page.goto).not.toHaveBeenCalledWith(otherModuleUrl, expect.anything());
    expect(result.event).toMatchObject({ type: 'submit_handoff' });
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
    expect(f.openClick).not.toHaveBeenCalled();
  });

  it('binds a localized TalentSoft heading to the paid posting URL, not the mutable application URL', async () => {
    const role = 'Gesamtverantwortliche/r Kundeninformation (60-100%)';
    const applyUrl = 'https://rhb-career.talent-soft.com/mein-portal/mein-lebenslauf-fuer-meine-bewerbung-fuer-gesamtverantwortliche-r-kundeninformation-60-100-_2233.aspx?ApplicationType=OfferApplication';
    const paidPostingUrl = applyUrl.replace('_2233.aspx', '_2234.aspx').replace('?ApplicationType=OfferApplication', '?source=paid-posting');
    const form = {
      ...snapshot(applyUrl, `Rhätische Bahn - Meine Bewerbung absenden\n${role}\nSie können nun Ihren Lebenslauf hochladen.`, [
        { id: 'next', text: 'Weiter' },
      ]),
      title: 'My application',
      fields: [{ id: 'cv', label: 'Lebenslauf', kind: 'file', inputType: 'file', required: true }],
    };
    const f = fixture(form, form, review, null, {
      applyUrl,
      postingUrl: paidPostingUrl,
      pageHeading: 'Rhätische Bahn - Meine Bewerbung absenden',
      job: { company: 'Ferrovia Retica (RhB)', title: role },
    });

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'posting_mismatch' });
    expect(result.evidence.postingMatch).toBe('mismatch');
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous TalentSoft heading set before arming the final submit', async () => {
    const role = 'Senior Engineer';
    const applyUrl = 'https://rhb-career.talent-soft.com/job/fixture_2233.aspx';
    const form = {
      ...snapshot(applyUrl, `${role}\nPlease complete your application.`, [
        { id: 'next', text: 'Continue' },
      ]),
      title: 'My application',
      fields: [{ id: 'cv', label: 'CV', kind: 'file', inputType: 'file', required: true }],
    };
    const f = fixture(form, form, review, null, {
      applyUrl,
      postingUrl: applyUrl,
      pageHeadings: ['Rhätische Bahn - My application', 'Other Resort - My application'],
      job: { company: 'Ferrovia Retica (RhB)', title: role },
    });

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'posting_mismatch' });
    expect(result.evidence.postingMatch).toBe('mismatch');
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('rejects a generic TalentSoft form whose requisition ID differs from the paid posting', async () => {
    const role = 'Senior Engineer';
    const paidPostingUrl = 'https://rhb-career.talent-soft.com/job/fixture_2233.aspx';
    const applyUrl = paidPostingUrl.replace('_2233.aspx', '_2234.aspx');
    const form = {
      ...snapshot(applyUrl, `${role}\nPlease complete your application.`, [
        { id: 'next', text: 'Continue' },
      ]),
      title: 'My application',
      fields: [{ id: 'cv', label: 'CV', kind: 'file', inputType: 'file', required: true }],
    };
    const f = fixture(form, form, review, null, {
      applyUrl,
      postingUrl: paidPostingUrl,
      pageHeadings: [],
      job: { company: 'Ferrovia Retica (RhB)', title: role },
    });

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'posting_mismatch' });
    expect(result.evidence.postingMatch).toBe('mismatch');
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('hands off the issue 17251 language-only shell without asking the candidate or guessing an apply URL', async () => {
    // Synthetic route; the issue preserves only /job/*/* and Sprache.
    const postingUrl = 'https://jobs.stadt-zuerich.ch/job/Synthetic-Role/42/';
    const shell = snapshot(postingUrl, 'Sprache', [{ id: 'language', text: 'Sprache', chrome: true }]);
    const f = fixture(shell, null, review, null, {
      applyUrl: postingUrl, postingUrl, channelType: 'successfactors',
      job: { title },
    });

    f.page.ariaSnapshot = async () => '- button "Sprache" [ref=e0]';
    f.codex.mockResolvedValue({ status: 'PARKED', reason: 'PARKED: no_job_entry', actions: [], advanceRef: '', submitRef: '', questions: [] });
    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'posting_mismatch' });
    expect(f.codex).toHaveBeenCalledOnce();
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
    expect(f.page.goto.mock.calls.every(([url]: [string]) => url === postingUrl)).toBe(true);
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
      [{ id: 'details', text: 'Mehr erfahren', href: '', disabled: false }]);
    const f = fixture(blockedPosting);

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'application_region_unsupported' });
    expect(f.openClick).not.toHaveBeenCalled();
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('passes Yellowshark regional copy when its cookie dialog leaves an application entry', async () => {
    const yellowsharkPosting = snapshot(applyUrl,
      'Leider können wir Bewerbungen aus Ihrer Region aktuell nicht unterstützen. Einreichen deiner Bewerbung in 10 Minuten.',
      [
        { id: 'close', text: 'Close dialog', chrome: true, cookieSurface: 'banner', cookieContextId: 'yellowshark', disabled: false },
        { id: 'accept', text: 'Alle akzeptieren', cookieSurface: 'banner', cookieContextId: 'yellowshark', context: 'Cookie consent', disabled: false },
        { id: 'reject', text: 'Ablehnen', cookieSurface: 'banner', cookieContextId: 'yellowshark', context: 'Cookie consent', disabled: false },
        { id: 'settings', text: 'Einstellungen anzeigen', cookieSurface: 'banner', cookieContextId: 'yellowshark', context: 'Cookie consent', disabled: false },
        { id: 'apply', text: 'JETZT BEWERBEN', section: title, context: 'Job ID: 42', disabled: false },
      ]);
    yellowsharkPosting.dialogs = [{ dialogId: 'd1' }];
    yellowsharkPosting.buttons.slice(0, 4).forEach((button: any) => { button.dialog = true; button.dialogId = 'd1'; });
    const afterCookie = {
      ...yellowsharkPosting,
      dialogs: [],
      buttons: [yellowsharkPosting.buttons.at(-1)],
    };
    const f = fixture(yellowsharkPosting, null, review, null, {
      buttonTransitions: {
        '[data-aa-id="reject"]': async () => { state.snapshot = afterCookie; },
        '[data-aa-id="apply"]': async () => { state.snapshot = profile; },
      },
    });

    const result = await f.run();

    expect(result.event).toEqual({ type: 'submit_succeeded', channel: 'portal' });
    expect(f.guard).toHaveBeenCalledOnce();
    expect(f.click).toHaveBeenCalledOnce();
  });

  // Order 1EpmkrDu (Yellowshark, 2026-11-04/06): the employer geolocates the
  // runner's IP. With the notice, its Apply control is greyed out and never
  // responds; 6 of 19 runs got no notice and reached the form.
  const regionNotice = 'Leider können wir Bewerbungen aus Ihrer Region aktuell nicht unterstützen.';
  const deadApplyClick = () => Promise.reject(new Error(
    'locator.click: Timeout 6000ms exceeded.\nCall log:\n  - waiting for locator(\'[data-aa-id="apply"]\').first()',
  ));

  it('reports the regional gate, not a dead click, when the notice stays and its Apply control never responds', async () => {
    const gated = snapshot(applyUrl, regionNotice,
      [{ id: 'apply', text: 'JETZT BEWERBEN', section: title, context: 'Job ID: 42', disabled: false }]);
    const f = fixture(gated, null, review, null, { buttonTransitions: { '[data-aa-id="apply"]': deadApplyClick } });

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'application_region_unsupported' });
    // No fix issue: the gate is on the runner's IP and the retry ladder owns it; the screenshot stays in the evidence.
    expect(result.evidence.stopReport).toBeUndefined();
    expect(result.evidence.handoffScreenshot).toBeTruthy();
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('keeps a dead Apply click as a control stop when the posting states no regional gate', async () => {
    const ungated = snapshot(applyUrl, 'Senden Sie Ihre Bewerbung in 3 einfachen Schritten.',
      [{ id: 'apply', text: 'JETZT BEWERBEN', section: title, context: 'Job ID: 42', disabled: false }]);
    const f = fixture(ungated, null, review, null, { buttonTransitions: { '[data-aa-id="apply"]': deadApplyClick } });

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'portal_control_click_unresolved' });
    expect(f.guard).not.toHaveBeenCalled();
  });

  it('resolves the explicit cookie choice before checking the Yellowshark posting identity', async () => {
    const postingUrl = 'https://jobs.yellowshark.com/job/example/?jobId=42';
    const cookieDialog = snapshot(postingUrl,
      'Dialog schliessen Alle akzeptieren Ablehnen Einstellungen anzeigen JETZT BEWERBEN',
      [
        { id: 'close', text: 'Dialog schliessen', chrome: true, cookieSurface: 'banner', cookieContextId: 'yellowshark', disabled: false },
        { id: 'accept', text: 'Alle akzeptieren', cookieSurface: 'banner', cookieContextId: 'yellowshark', context: 'Cookie consent', disabled: false },
        { id: 'reject', text: 'Ablehnen', cookieSurface: 'banner', cookieContextId: 'yellowshark', context: 'Cookie consent', disabled: false },
        { id: 'settings', text: 'Einstellungen anzeigen', cookieSurface: 'banner', cookieContextId: 'yellowshark', context: 'Cookie consent', disabled: false },
        { id: 'apply', text: 'JETZT BEWERBEN', section: title, context: 'Job ID: 42', disabled: false },
      ]);
    cookieDialog.title = 'Dialog schliessen';
    cookieDialog.dialogs = [{ dialogId: 'yellowshark' }];
    cookieDialog.buttons.slice(0, 4).forEach((button: any) => { button.dialog = true; button.dialogId = 'yellowshark'; });
    const visiblePosting = snapshot(postingUrl, 'Yellowshark AG · Infrastructure Strategy Manager', [
      { id: 'apply', text: 'JETZT BEWERBEN', section: title, context: 'Yellowshark AG — Infrastructure Strategy Manager · Job ID: 42', disabled: false },
    ]);
    visiblePosting.title = 'Yellowshark AG — Infrastructure Strategy Manager';
    // The fixture halts at a CAPTCHA after the owned Apply control; it must
    // never arm the final submit guard or click the final button.
    const captchaPage = { ...snapshot('https://jobs.yellowshark.com/application/', 'Verification required', []), captcha: true };
    const applyClicked = vi.fn(async () => { state.snapshot = captchaPage; });
    const f = fixture(cookieDialog, null, review, null, {
      applyUrl: postingUrl,
      postingUrl,
      job: { company: 'Yellowshark AG', title },
      agentSnapshot: (current: any) => current.buttons.map((button: any, index: number) => `- button "${button.text}" [ref=e${index}]`).join('\n'),
      agentControl: (current: any, ref: string) => {
        const control = current.buttons[Number(ref.slice(1))];
        if (!control) return null;
        return {
          selector: `[data-aa-id="${control.id}"]`,
          info: { name: control.text, labelName: '', otp: false, button: true, tag: 'button', inputType: 'button',
            editable: false, inList: false, inForm: false, href: control.href || '', submits: false,
            authForm: false, leaves: false, disabled: Boolean(control.disabled) },
        };
      },
      buttonTransitions: {
        '[data-aa-id="reject"]': async () => { state.snapshot = visiblePosting; },
        '[data-aa-id="apply"]': applyClicked,
      },
    });
    f.codex
      .mockResolvedValueOnce({ status: 'ACT', reason: '', actions: [{ ref: 'e0', action: 'click', value: '', document: 'none', question: '', context: '', answer: '', source: 'widget', evidence: '' }], advanceRef: '', submitRef: '', questions: [] })
      .mockResolvedValueOnce({ status: 'PARKED', reason: 'PARKED: challenge', actions: [], advanceRef: '', submitRef: '', questions: [] });

    const result = await f.run();

    expect(result.event.type).toBe('submit_handoff');
    expect(['captcha', 'captcha_present']).toContain(result.event.reason);
    expect(applyClicked).toHaveBeenCalledOnce();
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('keeps a regional notice terminal for an unrelated job-card application CTA', async () => {
    const unrelatedCta = snapshot(applyUrl,
      'Leider können wir Bewerbungen aus Ihrer Region aktuell nicht unterstützen.',
      [{ id: 'other-apply', text: 'JETZT BEWERBEN', section: 'Senior Data Analyst', disabled: false }]);
    const f = fixture(unrelatedCta);

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'application_region_unsupported' });
    expect(f.openClick).not.toHaveBeenCalled();
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  describe('a final click that only opens the final review (Deloitte Avature, order JvKpYedw)', () => {
    const summaryUrl = 'https://careers.example/Careers/ApplicationSummary?jobId=42';
    const reviewText = 'Please review the information below. Once you have reviewed, please select Submit to finalise your application.';
    const summary = snapshot(summaryUrl, reviewText, [{ id: 'final', text: 'Apply' }]);
    const recap = snapshot('https://careers.example/Careers/ApplicationRecap?jobId=42', reviewText, [{ id: 'again', text: 'Apply' }]);

    function reviewHarness(transitions: Record<string, () => void>) {
      state.snapshot = review;
      const clicks: string[] = [];
      const page: any = {
        url: () => state.snapshot.url, title: async () => title, frames: () => [page], mainFrame: () => page,
        goto: vi.fn(async () => ({ status: () => 200 })),
        evaluate: async (fn: Function) => {
          const source = String(fn);
          if (source.includes('navigator.userAgent')) return 'Chrome';
          return source.includes('document.body') ? state.snapshot.text : false;
        },
        waitForLoadState: async () => {}, waitForTimeout: async () => {}, screenshot: async () => Buffer.from('fixture'),
        getByRole: () => ({ count: async () => 0, filter: () => ({ first: () => ({ waitFor: async () => { throw new Error('not visible'); } }) }) }),
        locator: (selector: string) => ({
          count: async () => 0,
          first: () => ({
            click: async () => { clicks.push(selector); transitions[selector]?.(); },
            evaluate: async (_fn: Function, argument: any) => ({ ok: true, contractJson: JSON.stringify(argument) }),
          }),
        }),
      };
      const browser = { newContext: async () => ({ route: async () => {}, waitForEvent: async () => null, newPage: async () => page, close: async () => {} }), close: async () => {}, version: () => '151' };
      const guard = vi.fn(async () => {});
      const confirmedNotSent = vi.fn(async () => {});
      const run = () => submitViaPortal({
        applyUrl, job: { title }, language: 'en', candidate: { identity: {}, profile: {} }, files: {},
        codex: vi.fn(), launch: async () => browser, onBeforeSubmit: guard, onConfirmedNotSent: confirmedNotSent,
      });
      return { run, guard, confirmedNotSent, clicks };
    }

    it('releases the claim as not sent, then guards and confirms the review’s own final button', async () => {
      const h = reviewHarness({
        '[data-aa-id="commit"]': () => { state.snapshot = summary; },
        '[data-aa-id="final"]': () => { state.snapshot = receipt; },
      });

      const result = await h.run();

      expect(result.event).toEqual({ type: 'submit_succeeded', channel: 'portal' });
      expect(result.evidence.finalOutcomes).toEqual(['review_pending', 'confirmed']);
      expect(h.clicks).toEqual(['[data-aa-id="commit"]', '[data-aa-id="final"]']);
      expect(h.guard).toHaveBeenCalledTimes(2);
      expect(h.confirmedNotSent).toHaveBeenCalledOnce();
      expect(h.confirmedNotSent).toHaveBeenCalledWith({ reason: 'portal_review_pending' });
      // The first claim is released before the review's button is armed.
      expect(h.confirmedNotSent.mock.invocationCallOrder[0]).toBeLessThan(h.guard.mock.invocationCallOrder[1]);
    });

    it('hands off, released, when the review keeps opening another review', async () => {
      const h = reviewHarness({
        '[data-aa-id="commit"]': () => { state.snapshot = summary; },
        '[data-aa-id="final"]': () => { state.snapshot = recap; },
      });

      const result = await h.run();

      expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'application_stage_unknown' });
      expect(result.evidence.finalOutcomes).toEqual(['review_pending', 'review_pending']);
      expect(h.clicks).toEqual(['[data-aa-id="commit"]', '[data-aa-id="final"]']);
      expect(h.confirmedNotSent).toHaveBeenCalledTimes(2);
    });

    it('reads a final review only on another page of the same posting', () => {
      const context = { applyUrl, submissionUrl: reviewUrl, job: { title } };
      expect(advancedToFinalReview(summary, { ...context, url: summaryUrl })).toBe(true);
      // The page that was clicked still showing its instructions is an unknown outcome, not a new step.
      expect(advancedToFinalReview(review, { ...context, url: reviewUrl })).toBe(false);
      expect(advancedToFinalReview({ ...summary, url: 'https://careers.example/Careers/ApplicationSummary?jobId=43' },
        { ...context, url: 'https://careers.example/Careers/ApplicationSummary?jobId=43' })).toBe(false);
      expect(advancedToFinalReview(receipt, { ...context, url: receiptUrl })).toBe(false);
      expect(advancedToFinalReview(null, { ...context, url: summaryUrl })).toBe(false);
    });
  });

  it('routes a non-form loading page outside the selected posting through navigation recovery', async () => {
    const unrecognized = { ...snapshot(applyUrl, 'Please wait while the portal loads.', []), text: 'Please wait while the portal loads.', title: 'Careers' };
    const f = fixture(unrecognized);
    f.page.ariaSnapshot = async () => '- text "Please wait while the portal loads" [ref=e0]';
    f.codex.mockResolvedValue({ status: 'PARKED', reason: 'PARKED: loading_shell', actions: [], advanceRef: '', submitRef: '', questions: [] });

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'application_stage_unknown' });
    expect(f.codex).toHaveBeenCalledOnce();
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('routes a control-free page outside the selected route through navigation recovery', async () => {
    const otherTitle = { ...snapshot(applyUrl, 'Application portal is loading.', []),
      title: 'Different role', text: 'Application portal is loading.', fields: [] };
    const f = fixture(otherTitle);
    f.page.ariaSnapshot = async () => '- text "Application portal is loading" [ref=e0]';
    f.codex.mockResolvedValue({ status: 'PARKED', reason: 'PARKED: loading_shell', actions: [], advanceRef: '', submitRef: '', questions: [] });

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'application_stage_unknown' });
    expect(f.codex).toHaveBeenCalledOnce();
    expect(result.evidence.postingMatch).toBe('mismatch');
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('opens the posting-owned CTA when an unrelated Apply control comes first', async () => {
    const headerClick = vi.fn(async () => {});
    const matchingClick = vi.fn(async () => { state.snapshot = profile; });
    const mixedPosting = snapshot(applyUrl,
      'Leider können wir Bewerbungen aus Ihrer Region aktuell nicht unterstützen.',
      [
        { id: 'header-apply', text: 'JETZT BEWERBEN', href: 'https://careers.example/Careers/ApplicationMethods?jobId=99', disabled: false },
        { id: 'matching-apply', text: 'JETZT BEWERBEN', href: applyUrl, disabled: false },
      ]);
    const f = fixture(mixedPosting, null, review, null, {
      buttonTransitions: {
        '[data-aa-id="header-apply"]': headerClick,
        '[data-aa-id="matching-apply"]': matchingClick,
      },
    });

    const result = await f.run();

    expect(result.event).toEqual({ type: 'submit_succeeded', channel: 'portal' });
    expect(headerClick).not.toHaveBeenCalled();
    expect(matchingClick).toHaveBeenCalledOnce();
  });

  it('keeps a regional notice terminal when a same-title no-href CTA lacks the current posting identity', async () => {
    const ambiguousPosting = snapshot(applyUrl,
      'Leider können wir Bewerbungen aus Ihrer Region aktuell nicht unterstützen.',
      [
        { id: 'other-apply', text: 'JETZT BEWERBEN', section: title, context: 'Job ID: 43', disabled: false },
        { id: 'title-only-apply', text: 'JETZT BEWERBEN', section: title, disabled: false },
      ]);
    const f = fixture(ambiguousPosting);

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'application_region_unsupported' });
    expect(f.openClick).not.toHaveBeenCalled();
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('keeps a regional notice terminal for a same-employer CTA on another role', async () => {
    const unrelatedCta = {
      ...snapshot(applyUrl,
        'Acme AG. Leider können wir Bewerbungen aus Ihrer Region aktuell nicht unterstützen.',
        [{ id: 'other-apply', text: 'JETZT BEWERBEN', section: 'Acme AG — Junior Accountant', disabled: false }]),
      title: 'Senior Engineer — Acme AG',
      text: 'Senior Engineer. Acme AG. Leider können wir Bewerbungen aus Ihrer Region aktuell nicht unterstützen.',
    };
    const f = fixture(unrelatedCta, null, review, null, { job: { company: 'Acme AG', title: 'Senior Engineer' } });

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'application_region_unsupported' });
    expect(f.openClick).not.toHaveBeenCalled();
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });

  it('keeps posting_mismatch for an application surface that names another role', async () => {
    const otherRole = { ...snapshot(applyUrl, 'Application for a different role.', []),
      title: 'Different role', text: 'Application for a different role.',
      fields: [{ id: 'note', kind: 'text', inputType: 'text', label: 'Application note', formId: 'application', frame: 0 }] };
    const f = fixture(profile, otherRole);

    const result = await f.run();

    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'posting_mismatch' });
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
    const codex = vi.fn(async () => ({ status: 'REACHED_FORM', reason: 'test', actions: [], advanceRef: 'e0', submitRef: '', questions: [] }));

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
    const source = { ...snapshot(postingUrl, 'Read this vacancy and apply.', [{ id: 'open', text: 'Apply', section: title, context: 'Posting ID: 42' }]), protocol: await portalProtocolFromHtml(markup('JobDetail'), postingUrl) };
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
    const gallery = snapshot('https://careers.example/Careers/ApplicationMethods/bewerbungstipps/?jobId=42', 'Public content.', [
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
      ariaSnapshot: async () => state.snapshot.buttons.map((button: any, index: number) => `- button "${button.text}" [ref=e${index}]`).join('\n'),
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
    expect(codex).toHaveBeenCalledOnce();
  });
});
