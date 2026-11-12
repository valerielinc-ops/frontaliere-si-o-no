import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { armFinalFormClickGuardInPage, clearFinalFormGuardInPage, installFinalFormGuardCaptureInPage, readFinalFormGuardStatusInPage } from '../scripts/assisted-application/lib/portal/form-contract.mjs';

const opened: JSDOM[] = [];
function fixture(markup = `<form data-aa-id="f1" id="application" action="/submit" method="post">
  <label for="email">Email</label><input data-aa-id="i1" id="email" name="email" type="email" value="candidate@example.test" required>
  <input name="portal-password" type="password" value="super-secret-fixture-password">
  <button data-aa-id="b1" type="submit">Apply</button>
</form>`) {
  const dom = new JSDOM(markup, { url: 'https://careers.example.test/apply?job=fixture' });
  opened.push(dom);
  return { dom, button: dom.window.document.querySelector('[data-aa-id="b1"]') as HTMLButtonElement,
    input: dom.window.document.querySelector('[data-aa-id="i1"]') as HTMLInputElement };
}
const arm = (button: HTMLButtonElement, token = 'fixture-token') => {
  installFinalFormGuardCaptureInPage(button.ownerDocument);
  return armFinalFormClickGuardInPage(button, {
    token, expectedButtonId: 'b1', expectedFormId: 'f1', expectedButtonName: 'Apply',
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dom of opened.splice(0)) dom.window.close();
});

it('collects a canonical contract only after the selected submitter is linked to its native form', () => {
  const { button } = fixture();
  const result = arm(button);
  expect(result).toMatchObject({ ok: true, buttonId: 'b1', formId: 'f1', nativeFormId: 'application' });
  expect(result.contractJson).toContain('candidate@example.test');
  expect(result.contractJson).toContain('method');
  expect(result.contractJson).not.toContain('super-secret-fixture-password');
  expect(clearFinalFormGuardInPage(button, 'fixture-token')).toBe(true);
});

it('blocks synchronously before portal click handlers when a field changes after the form was armed', () => {
  const { dom, button, input } = fixture();
  const appClicks = vi.fn();
  button.addEventListener('click', appClicks);
  expect(arm(button).ok).toBe(true);
  input.value = 'changed@example.test';

  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  button.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(appClicks).not.toHaveBeenCalled();
  expect(readFinalFormGuardStatusInPage(button, 'fixture-token')).toBe('blocked_before_click');
});

it('binds the effective form route and submitter overrides', () => {
  const { dom, button } = fixture();
  expect(arm(button).ok).toBe(true);
  button.setAttribute('formaction', '/different-application');
  button.setAttribute('formmethod', 'get');

  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  button.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(readFinalFormGuardStatusInPage(button, 'fixture-token')).toBe('blocked_before_click');
});

it('blocks when an owning fieldset becomes disabled after arming', () => {
  const { dom, button } = fixture(`<form data-aa-id="f1" id="application" action="/submit" method="post">
    <button data-aa-id="b1" type="submit">Apply</button>
    <fieldset id="candidate-address"><legend>Address</legend><input name="street" value="Via Roma 1"></fieldset>
  </form>`);
  const fieldset = dom.window.document.querySelector('#candidate-address') as HTMLFieldSetElement;
  expect(arm(button).ok).toBe(true);
  fieldset.disabled = true;

  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  button.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(readFinalFormGuardStatusInPage(button, 'fixture-token')).toBe('blocked_before_click');
});

it('binds the submitter action resolved against the current base URL', () => {
  const { dom, button } = fixture(`<base href="https://example.invalid/one/"><form data-aa-id="f1" id="application" action="/submit" method="post">
    <button data-aa-id="b1" type="submit" formaction="submit">Apply</button>
  </form>`);
  expect(arm(button).ok).toBe(true);
  dom.window.document.querySelector('base')!.setAttribute('href', 'https://example.invalid/two/');

  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  button.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(readFinalFormGuardStatusInPage(button, 'fixture-token')).toBe('blocked_before_click');
});

it('keeps a blocked pointerdown from being followed by an unguarded click', () => {
  const { dom, button, input } = fixture();
  const portalPointer = vi.fn();
  const portalClick = vi.fn();
  button.addEventListener('pointerdown', portalPointer);
  button.addEventListener('click', portalClick);
  expect(arm(button).ok).toBe(true);
  input.value = 'changed-before-pointerdown@example.test';

  button.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  button.dispatchEvent(click);

  expect(portalPointer).not.toHaveBeenCalled();
  expect(click.defaultPrevented).toBe(true);
  expect(portalClick).not.toHaveBeenCalled();
  expect(readFinalFormGuardStatusInPage(button, 'fixture-token')).toBe('blocked_before_click');
});

it('checks the form before page pointer handlers and again before click handlers', () => {
  const { dom, button, input } = fixture();
  const portalPointer = vi.fn(() => { input.value = 'changed-on-pointerdown@example.test'; });
  const portalClick = vi.fn();
  installFinalFormGuardCaptureInPage(dom.window.document);
  dom.window.addEventListener('pointerdown', portalPointer, true);
  button.addEventListener('click', portalClick);
  expect(arm(button).ok).toBe(true);

  button.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  button.dispatchEvent(click);

  expect(portalPointer).toHaveBeenCalledTimes(1);
  expect(click.defaultPrevented).toBe(true);
  expect(portalClick).not.toHaveBeenCalled();
  expect(readFinalFormGuardStatusInPage(button, 'fixture-token')).toBe('blocked_before_click');
});

it('blocks a replacement submitter even when it has the same name and the form content is unchanged', () => {
  const { dom, button } = fixture();
  const appClicks = vi.fn();
  expect(arm(button).ok).toBe(true);
  const replacement = button.cloneNode(true) as HTMLButtonElement;
  button.replaceWith(replacement);
  replacement.addEventListener('click', appClicks);

  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  replacement.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(appClicks).not.toHaveBeenCalled();
  expect(readFinalFormGuardStatusInPage(replacement, 'fixture-token')).toBe('blocked_before_click');
});

it('rejects a missing or mismatched native form link before the click can be armed', () => {
  const { dom, button } = fixture(`<div><input data-aa-id="i1" name="email" value="candidate@example.test">
    <button data-aa-id="b1" type="submit">Apply</button></div>`);
  expect(arm(button)).toEqual({ ok: false, reason: 'form_unlinked' });

  const form = dom.window.document.createElement('form');
  form.setAttribute('data-aa-id', 'different-form');
  const input = dom.window.document.createElement('input');
  input.setAttribute('data-aa-id', 'i1');
  input.name = 'email';
  const linkedButton = dom.window.document.createElement('button');
  linkedButton.setAttribute('data-aa-id', 'b1');
  linkedButton.textContent = 'Apply';
  form.append(input, linkedButton);
  dom.window.document.body.append(form);
  expect(armFinalFormClickGuardInPage(linkedButton, { token: 'wrong-form', expectedButtonId: 'b1', expectedFormId: 'f1', expectedButtonName: 'Apply' }))
    .toMatchObject({ ok: false, reason: 'form_binding_changed', buttonId: 'b1', formId: 'different-form' });
});

it('allows secondary programmatic submit click in the same form after the primary submit button was checked', () => {
  const { dom, button } = fixture(`<form data-aa-id="f1" id="application" action="/submit" method="post">
    <input data-aa-id="i1" name="email" value="candidate@example.test" required>
    <input type="hidden" id="hcaptchaResponseInput" name="h-captcha-response" value="">
    <button id="hcaptchaSubmitBtn" type="submit" class="hidden">Hidden Submit</button>
    <button data-aa-id="b1" id="btn-submit" type="button">Apply</button>
  </form>`);
  const form = dom.window.document.querySelector('form') as HTMLFormElement;
  const hiddenSubmit = dom.window.document.querySelector('#hcaptchaSubmitBtn') as HTMLButtonElement;
  const captchaInput = dom.window.document.querySelector('#hcaptchaResponseInput') as HTMLInputElement;

  const hiddenSubmitClicks = vi.fn();
  hiddenSubmit.addEventListener('click', hiddenSubmitClicks);

  button.addEventListener('click', () => {
    // Simulate ATS/Lever captcha callback: populates captcha token and clicks hidden submit button
    captchaInput.value = 'token-12345';
    hiddenSubmit.click();
  });

  expect(arm(button).ok).toBe(true);

  // Dispatch click on the armed visible button
  const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  button.dispatchEvent(click);

  expect(click.defaultPrevented).toBe(false);
  expect(hiddenSubmitClicks).toHaveBeenCalledTimes(1);
  expect(readFinalFormGuardStatusInPage(button, 'fixture-token')).toBe('click_checked');
});

it('ignores dynamic captcha tokens and injected captcha controls in contract collection', () => {
  const { dom, button } = fixture(`<form data-aa-id="f1" id="application" action="/submit" method="post">
    <input data-aa-id="i1" name="email" value="candidate@example.test" required>
    <input type="hidden" name="cf-turnstile-response" value="">
    <button data-aa-id="b1" type="submit">Apply</button>
  </form>`);
  const form = dom.window.document.querySelector('form') as HTMLFormElement;
  const turnstileInput = dom.window.document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement;

  expect(arm(button).ok).toBe(true);

  // Dynamic token populated and injected captcha textarea
  turnstileInput.value = 'cf-token-dynamic-999';
  const injected = dom.window.document.createElement('textarea');
  injected.name = 'g-recaptcha-response';
  injected.value = 'dynamic-g-recaptcha-token';
  form.appendChild(injected);

  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  button.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(false);
  expect(readFinalFormGuardStatusInPage(button, 'fixture-token')).toBe('click_checked');
});

it('resolves the submitter when clicking a child element inside the button', () => {
  const { dom, button } = fixture(`<form data-aa-id="f1" id="application" action="/submit" method="post">
    <input data-aa-id="i1" name="email" value="candidate@example.test" required>
    <button data-aa-id="b1" type="submit"><span id="inner-label">Apply Now</span></button>
  </form>`);
  const span = dom.window.document.querySelector('#inner-label') as HTMLSpanElement;

  expect(arm(button, 'fixture-token').ok).toBe(true);

  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  span.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(false);
  expect(readFinalFormGuardStatusInPage(button, 'fixture-token')).toBe('click_checked');
});

it('allows secondary submit and submitter UI transitions (disabled, loading text) after primary click', () => {
  const { dom, button } = fixture(`<form data-aa-id="f1" id="application" action="/submit" method="post">
    <input data-aa-id="i1" name="email" value="candidate@example.test" required>
    <button id="hcaptchaSubmitBtn" type="submit" class="hidden">Hidden Submit</button>
    <button data-aa-id="b1" id="btn-submit" type="button">Apply</button>
  </form>`);
  const hiddenSubmit = dom.window.document.querySelector('#hcaptchaSubmitBtn') as HTMLButtonElement;

  const hiddenSubmitClicks = vi.fn();
  hiddenSubmit.addEventListener('click', hiddenSubmitClicks);

  button.addEventListener('click', () => {
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.textContent = 'Submitting application...';
    hiddenSubmit.click();
  });

  expect(arm(button).ok).toBe(true);

  const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  button.dispatchEvent(click);

  expect(click.defaultPrevented).toBe(false);
  expect(hiddenSubmitClicks).toHaveBeenCalledTimes(1);
  expect(readFinalFormGuardStatusInPage(button, 'fixture-token')).toBe('click_checked');
});

it('ignores clicks on non-submitter links or utility controls within the same form', () => {
  const { dom, button } = fixture(`<form data-aa-id="f1" id="application" action="/submit" method="post">
    <input data-aa-id="i1" name="email" value="candidate@example.test" required>
    <a id="privacy-link" href="https://example.test/privacy">Privacy Policy</a>
    <a id="upload-link" class="postings-btn template-btn-utility">Attach Resume</a>
    <button data-aa-id="b1" type="submit">Apply</button>
  </form>`);
  const privacyLink = dom.window.document.querySelector('#privacy-link') as HTMLAnchorElement;
  const uploadLink = dom.window.document.querySelector('#upload-link') as HTMLAnchorElement;

  expect(arm(button).ok).toBe(true);

  const linkClick1 = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  privacyLink.dispatchEvent(linkClick1);
  expect(linkClick1.defaultPrevented).toBe(false);

  const linkClick2 = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  uploadLink.dispatchEvent(linkClick2);
  expect(linkClick2.defaultPrevented).toBe(false);

  expect(readFinalFormGuardStatusInPage(button, 'fixture-token')).toBe('armed');

  const submitClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  button.dispatchEvent(submitClick);

  expect(submitClick.defaultPrevented).toBe(false);
  expect(readFinalFormGuardStatusInPage(button, 'fixture-token')).toBe('click_checked');
});

it('ignores dynamic ATS telemetry fields like resumeStorageId, timezone, and referrer', () => {
  const { dom, button } = fixture(`<form data-aa-id="f1" id="application" action="/submit" method="post">
    <input data-aa-id="i1" name="email" value="candidate@example.test" required>
    <input type="hidden" name="resumeStorageId" value="">
    <input type="hidden" name="timezone" id="applicant-timezone" value="UTC">
    <input type="hidden" name="source" value="">
    <input type="hidden" name="referer" value="">
    <button data-aa-id="b1" type="submit">Apply</button>
  </form>`);
  const resumeStorage = dom.window.document.querySelector('input[name="resumeStorageId"]') as HTMLInputElement;
  const timezone = dom.window.document.querySelector('input[name="timezone"]') as HTMLInputElement;
  const source = dom.window.document.querySelector('input[name="source"]') as HTMLInputElement;

  expect(arm(button).ok).toBe(true);

  resumeStorage.value = 'parsed-resume-storage-uuid-999';
  timezone.value = 'Europe/Zurich';
  source.value = 'frontaliere';

  const submitClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  button.dispatchEvent(submitClick);

  expect(submitClick.defaultPrevented).toBe(false);
  expect(readFinalFormGuardStatusInPage(button, 'fixture-token')).toBe('click_checked');
});
