import { describe, expect, it } from 'vitest';
import {
  SUCCESS_FACTORS_ENTRY_REOPEN_LIMIT,
  successFactorsEntryReopenTarget,
} from '../scripts/assisted-application/lib/portal/portal.mjs';
import { verificationOutcome } from '../scripts/assisted-application/lib/portal/account.mjs';

// Synthetic SuccessFactors tenant. After sign-in or account activation the tenant can serve its profile
// shell at /portalcareer («Retour à la liste des postes», «Mon profil de candidature», no field) instead of
// the requisition's form. Only the module route proven for the posting may be reopened.
const applyUrl = 'https://career99.sapsf.eu/career?company=examplecorp&career_ns=job_application&career_job_req_id=4711';
const postingUrl = 'https://jobs.example.test/job/Lugano-Analyst/123456/';
const proof = { via: 'successfactors', applyUrl, postingUrl };
const shell = {
  url: 'https://career99.sapsf.eu/portalcareer',
  fields: [],
  buttons: [
    { id: 'back', text: 'Retour à la liste des postes', disabled: false, frame: 0 },
    { id: 'profile', text: 'Mon profil de candidature', disabled: false, frame: 0 },
  ],
  links: [], dialogs: [], errors: [], captcha: false, passwordVisible: false,
  text: 'Mon profil de candidature',
};
const base = { pageUrl: 'https://career99.sapsf.eu/portalcareer', applyUrl, postingUrl, postingRouteProof: proof, snapshot: shell };

describe('SuccessFactors profile shell beside the application', () => {
  it('goes back to the proven module route, also across hosts of the tenant', () => {
    expect(successFactorsEntryReopenTarget(base)).toBe(applyUrl);
    expect(successFactorsEntryReopenTarget({ ...base, pageUrl: 'https://career2.successfactors.eu/portalcareer?_s.crb=x' })).toBe(applyUrl);
  });

  it('is bounded', () => {
    expect(successFactorsEntryReopenTarget({ ...base, reopened: SUCCESS_FACTORS_ENTRY_REOPEN_LIMIT - 1 })).toBe(applyUrl);
    expect(successFactorsEntryReopenTarget({ ...base, reopened: SUCCESS_FACTORS_ENTRY_REOPEN_LIMIT })).toBe('');
  });

  it('stays fail-closed without the resolver proof for this exact posting', () => {
    expect(successFactorsEntryReopenTarget({ ...base, postingRouteProof: null })).toBe('');
    expect(successFactorsEntryReopenTarget({ ...base, postingRouteProof: { ...proof, via: 'prospective' } })).toBe('');
    // The proof names another posting: the module route says nothing about this one.
    expect(successFactorsEntryReopenTarget({ ...base, postingRouteProof: { ...proof, postingUrl: 'https://jobs.example.test/job/Other/999/' } })).toBe('');
    // A different module route than the proven one.
    expect(successFactorsEntryReopenTarget({ ...base, applyUrl: applyUrl.replace('4711', '4712') })).toBe('');
  });

  it('never leaves a page that is not a SuccessFactors career surface, or is already the route', () => {
    expect(successFactorsEntryReopenTarget({ ...base, pageUrl: 'https://jobs.example.test/job/x/' })).toBe('');
    expect(successFactorsEntryReopenTarget({ ...base, pageUrl: applyUrl })).toBe('');
    expect(successFactorsEntryReopenTarget({ ...base, pageUrl: 'https://career99.sapsf.eu/search' })).toBe('');
  });

  it('does not reload a page that has a form, a password or a code to enter', () => {
    const form = { ...shell, fields: [
      { id: 'a', kind: 'text', inputType: 'text', label: 'Vorname' },
      { id: 'b', kind: 'text', inputType: 'email', label: 'E-mail' },
      { id: 'c', kind: 'file', inputType: 'file', label: 'CV' },
    ] };
    expect(successFactorsEntryReopenTarget({ ...base, snapshot: form })).toBe('');
    const signIn = { ...shell, passwordVisible: true, fields: [{ id: 'p', kind: 'text', inputType: 'password', label: 'Mot de passe' }] };
    expect(successFactorsEntryReopenTarget({ ...base, snapshot: signIn })).toBe('');
    const question = { ...shell, fields: [{ id: 'q', kind: 'text', inputType: 'text', label: 'Salaire' }] };
    expect(successFactorsEntryReopenTarget({ ...base, snapshot: question })).toBe('');
  });
});

describe('SuccessFactors activation link landing', () => {
  const landing = (text: string, buttons: Array<{ text: string; disabled?: boolean }>) => ({
    url: 'https://career99.sapsf.eu/career',
    fields: [], links: [], dialogs: [], errors: [], captcha: false, passwordVisible: false,
    buttons: buttons.map((button, index) => ({ id: `b${index}`, disabled: false, frame: 0, ...button })),
    text,
  });

  it('takes «Continuer à postuler» with nothing to fill as the activated account', () => {
    expect(verificationOutcome(landing('Votre compte est prêt.', [{ text: 'Retour à la liste des postes' }, { text: 'Continuer à postuler' }]))).toBe('accepted');
    expect(verificationOutcome(landing('Account ready.', [{ text: 'Continue applying' }]))).toBe('accepted');
  });

  it('keeps the pending notice, the resend page and a disabled control unconfirmed', () => {
    expect(verificationOutcome(landing('E-mail d’activation envoyé. Votre compte n’a pas encore été activé.', [{ text: 'Renvoyer' }, { text: 'Continuer à postuler' }]))).toBe('unconfirmed');
    expect(verificationOutcome(landing('Page', [{ text: 'Retour à la liste des postes' }, { text: 'Renvoyer' }]))).toBe('unconfirmed');
    expect(verificationOutcome(landing('Page', [{ text: 'Continuer à postuler', disabled: true }]))).toBe('unconfirmed');
  });
});
