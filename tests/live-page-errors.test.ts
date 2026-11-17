import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  firstPageErrorFrameUrl,
  isThirdPartyOnlyStack,
  ownHostOf,
  splitPageErrors,
  type CapturedPageError,
} from './e2e/lib/page-errors';

const ownHost = 'frontaliereticino.ch';
const clarityStack = `Uncaught TypeError: Cannot read properties of undefined (reading 'apply')
    at _n.<computed> (https://scripts.clarity.ms/0.8.80-beta/clarity.js:1:63060)
    at xo (https://scripts.clarity.ms/0.8.80-beta/clarity.js:1:63103)
    at <anonymous> (https://scripts.clarity.ms/0.8.80-beta/clarity.js:1:73892)
    at <anonymous> (https://scripts.clarity.ms/0.8.80-beta/clarity.js:1:73897)`;

describe('live page error classification', () => {
  it('recognizes the observed Clarity error as third-party only', () => {
    expect(isThirdPartyOnlyStack(clarityStack, ownHost)).toBe(true);
    expect(firstPageErrorFrameUrl(clarityStack)).toBe(
      'https://scripts.clarity.ms/0.8.80-beta/clarity.js:1:63060',
    );
  });

  it('keeps first-party host and CDN frames fail-closed', () => {
    expect(isThirdPartyOnlyStack('Error\n    at script (https://frontaliereticino.ch/assets/index-abc.js:1:2)', ownHost)).toBe(false);
    expect(isThirdPartyOnlyStack('Error\n    at script (https://cdn.frontaliereticino.ch/assets/x.js:1:2)', ownHost)).toBe(false);
  });

  it('keeps mixed stacks fail-closed when any frame is first-party', () => {
    const mixedStack = `${clarityStack}\n    at script (https://frontaliereticino.ch/assets/index-abc.js:1:2)`;
    expect(isThirdPartyOnlyStack(mixedStack, ownHost)).toBe(false);
  });

  it('keeps missing stacks, URL-less stacks, and invalid own hosts fail-closed', () => {
    expect(isThirdPartyOnlyStack('', ownHost)).toBe(false);
    expect(isThirdPartyOnlyStack(undefined as unknown as string, ownHost)).toBe(false);
    expect(isThirdPartyOnlyStack('Error\n    at <anonymous>', ownHost)).toBe(false);
    expect(ownHostOf('not a URL')).toBe('');
    expect(isThirdPartyOnlyStack(clarityStack, ownHostOf('not a URL'))).toBe(false);
  });

  it('does not mistake a hostname suffix for an own subdomain', () => {
    expect(isThirdPartyOnlyStack('Error\n    at script (https://evilfrontaliereticino.ch/track.js:1:1)', ownHost)).toBe(true);
  });

  it('splits captured page errors into first-party and third-party groups', () => {
    const thirdPartyError: CapturedPageError = { name: 'TypeError', message: 'Clarity failed', stack: clarityStack };
    const ownError: CapturedPageError = {
      name: 'Error',
      message: 'Application failed',
      stack: 'Error\n    at script (https://frontaliereticino.ch/assets/index-abc.js:1:2)',
    };
    const unknownError: CapturedPageError = { name: 'Error', message: 'No stack', stack: '' };

    expect(splitPageErrors([thirdPartyError, ownError, unknownError], ownHost)).toEqual({
      own: [ownError, unknownError],
      thirdParty: [thirdPartyError],
    });
  });

  it('keeps the live spec wired to shared classification and visible third-party annotations', () => {
    const companyFollowSource = readFileSync(
      new URL('./e2e/company-follow-cta-position-live.spec.ts', import.meta.url),
      'utf8',
    );

    expect(companyFollowSource).toContain("from './lib/page-errors'");
    expect(companyFollowSource).not.toContain('pageErrors.push(err.message)');
    expect(companyFollowSource).toContain('third-party-pageerror');
  });
});
