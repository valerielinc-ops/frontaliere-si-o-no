import { describe, expect, it } from 'vitest';
import { passwordResetRequestAcknowledged } from '../scripts/assisted-application/lib/portal/portal.mjs';

describe('the portal page that says a password-reset request was taken', () => {
  it.each([
    ['Avature, after the request', 'Forgot your password Check your email If the email address you entered is associated with an account in our records, you will receive an email from us with instructions for resetting your password. Please note all links are valid for 48 hours.'],
    ['a plain confirmation', "We've sent you a link to reset your password."],
    ['instructions sent', 'The reset instructions have been sent to your address.'],
    ['German', 'Bitte prüfen Sie Ihre E-Mails.'],
    ['French', 'Vérifiez votre boîte de réception.'],
    ['Italian', 'Controlla la tua e-mail per le istruzioni.'],
  ])('recognises %s', (_name, text) => {
    expect(passwordResetRequestAcknowledged(text)).toBe(true);
  });

  it.each([
    ['the request form itself', 'Forgot your password? Enter the email address associated with your account, then click "Continue". We will email you a link to reset your password.'],
    ['an empty page', ''],
    ['a login page', 'Username (private email address) Password Login Forgot your password?'],
  ])('does not take %s for an acknowledgement', (_name, text) => {
    expect(passwordResetRequestAcknowledged(text)).toBe(false);
  });
});
