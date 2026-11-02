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
  expect(result).toMatchObject({ ok: true, buttonId: 'b1', formId: 'f1' });
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
