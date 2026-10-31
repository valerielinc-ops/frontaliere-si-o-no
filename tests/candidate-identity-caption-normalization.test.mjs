import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  candidateIdentityRole,
  identityControlRole,
  isCandidateIdentityTarget,
} from '../functions/src/lib/candidateIdentityContract.js';

const text = (question, extra = {}) => ({ question, kind: 'text', ...extra });
const target = (question, extra = {}) => text(question, { ownedScopes: [], ...extra });
const ownedScope = (...names) => ({ kind: 'group', names, unknown: false });

test('spaced edge decorators keep the whole-caption role in IT/DE/EN/FR', () => {
  const cases = [
    ['Nome: *', 'firstName'],
    ['Cognome : *', 'lastName'],
    ['Nome e cognome: *', 'fullName'],
    ['Indirizzo e-mail: *', 'email'],
    ['Telefono: *', 'phone'],
    ['Vorname: *', 'firstName'],
    ['Nachname : *', 'lastName'],
    ['E-Mail: *', 'email'],
    ['Telefonnummer: *', 'phone'],
    ['Telefonvorwahl: *', 'phoneCountry'],
    ['First name: *', 'firstName'],
    ['Last name: *', 'lastName'],
    ['Name: *', 'fullName'],
    ['Email: *', 'email'],
    ['LinkedIn profile: *', 'linkedin'],
    ['Prénom : *', 'firstName'],
    ['Nom : *', 'lastName'],
    ['Courriel : *', 'email'],
    ['Téléphone : *', 'phone'],
  ];
  for (const [question, role] of cases) {
    assert.equal(candidateIdentityRole(text(question)), role, question);
  }
});

test('decorator order, repetition and Unicode forms normalize alike', () => {
  for (const question of [
    'Vorname * :',
    'Vorname : * :',
    '* Vorname: *',
    ' ＊ Vorname ： ＊ ',
    'Vorname\u00a0:\u00a0*',
    'Vorname\u202f:\u202f*',
  ]) {
    assert.equal(candidateIdentityRole(text(question)), 'firstName', question);
  }
});

test('captions that were already valid keep their role', () => {
  for (const [question, role] of [
    ['Vorname', 'firstName'],
    ['Vorname:', 'firstName'],
    ['Vorname:*', 'firstName'],
    ['Vorname*', 'firstName'],
    ['* Vorname', 'firstName'],
    ['Email?', 'email'],
    ['Email (required)', 'email'],
    ['What is your email?', 'email'],
    ['Your email:*', 'email'],
  ]) {
    assert.equal(candidateIdentityRole(text(question)), role, question);
  }
});

test('required and optional suffixes combine with spaced decorators', () => {
  for (const [question, role] of [
    ['Email: (required)', 'email'],
    ['Email * (required)', 'email'],
    ['Email (required): *', 'email'],
    ['Vorname: (Pflichtfeld) *', 'firstName'],
    ['Telefon * (erforderlich)', 'phone'],
    ['Cognome: (obbligatorio)', 'lastName'],
    ['Cellulare (facoltativo) : *', 'phone'],
    ['Prénom : (obligatoire) *', 'firstName'],
  ]) {
    assert.equal(candidateIdentityRole(text(question)), role, question);
  }
});

test('unknown labels and meaningful extra text stay unknown', () => {
  for (const question of [
    '',
    '*',
    ': *',
    'Spitzname: *',
    'Email aziendale: *',
    'Vorname: Mario *',
    'Vorname: * Nachname',
    'Vorname * Nachname',
    'Email: personale',
    'Vorname (Kind): *',
    'Vorname (required) (optional)',
    'Telefonnummer der Firma: *',
  ]) {
    assert.equal(candidateIdentityRole(text(question)), '', question);
    assert.equal(isCandidateIdentityTarget(target(`Your ${question}`)), false, question);
  }
});

test('control guards still reject a normalized caption', () => {
  assert.equal(candidateIdentityRole(text('Email: *', { controlType: 'tel' })), '');
  assert.equal(candidateIdentityRole(text('Vorname: *', { controlType: 'email' })), '');
  assert.equal(candidateIdentityRole(text('Vorname: *', { controlType: 'password' })), '');
  assert.equal(candidateIdentityRole(text('Email: *', { autocomplete: 'given-name' })), '');
  assert.equal(candidateIdentityRole({ question: 'Email: *', kind: 'select' }), '');
  assert.equal(candidateIdentityRole({ question: 'Prefisso telefonico: *', kind: 'select' }), 'phoneCountry');
});

test('other actors never become the candidate after normalization', () => {
  for (const [question, controlRole] of [
    ['Reference email: *', 'email'],
    ['Employer email : *', 'email'],
    ['Email of the reference: *', 'email'],
    ['Telefon des Arbeitgebers: *', 'phone'],
    ['Datore di lavoro email: *', 'email'],
    ['Employer name: *', ''],
    ['Spouse name: *', 'fullName'],
  ]) {
    assert.equal(candidateIdentityRole(text(question)), '', question);
    assert.equal(identityControlRole(text(question)), controlRole, question);
    assert.equal(isCandidateIdentityTarget(target(question, {
      ownedScopes: [ownedScope('Personal details')],
    })), false, question);
  }
});

test('spaced decorators do not weaken ownership proof', () => {
  assert.equal(isCandidateIdentityTarget(target('Email: *')), false, 'bare caption proves no owner');
  assert.equal(isCandidateIdentityTarget(target('Your email: *')), true);
  assert.equal(isCandidateIdentityTarget(target('Email: *', {
    ownedScopes: [ownedScope('Personal details : *')],
  })), true);
  assert.equal(isCandidateIdentityTarget(target('Email: *', { context: 'Personal details: *' })), true);
  assert.equal(isCandidateIdentityTarget(target('Your email: *', {
    ownedScopes: [{ kind: 'group', names: ['Personal details'], unknown: true }],
  })), false, 'unknown scope');
  assert.equal(isCandidateIdentityTarget(target('Your email: *', {
    ownedScopes: [ownedScope('Reference details: *')],
  })), false, 'foreign scope');
  assert.equal(isCandidateIdentityTarget(target('Your email: *', { context: 'Emergency contact: *' })), false);
  assert.equal(isCandidateIdentityTarget(target('Your email: *', { section: 'Employer : *' })), false);
  assert.equal(isCandidateIdentityTarget(text('Your email: *')), false, 'missing scopes');
});
