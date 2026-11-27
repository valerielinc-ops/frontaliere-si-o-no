import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type HostingRedirect = {
  regex?: string;
  destination?: string;
  type?: number;
};

const FIREBASE_CONFIG = JSON.parse(readFileSync(resolve('firebase.json'), 'utf8')) as {
  hosting?: {
    redirects?: HostingRedirect[];
    rewrites?: unknown;
  };
};

function toJavaScriptRegex(firebaseRegex: string): RegExp {
  return new RegExp(firebaseRegex.replace('(?P<p>', '(?<p>'));
}

describe('Firebase Hosting redirect', () => {
  it('preserves non-reserved paths and excludes the /__ namespace', () => {
    const hosting = FIREBASE_CONFIG.hosting;
    const redirects = hosting?.redirects ?? [];

    expect(redirects).toHaveLength(1);
    expect(hosting).not.toHaveProperty('rewrites');

    const redirect = redirects[0];
    if (!redirect) throw new Error('Firebase Hosting redirect is missing');

    expect(redirect).toMatchObject({
      regex: '^/(?P<p>(?:[^_]|_[^_]).*)?$',
      destination: 'https://frontaliereticino.ch/:p',
      type: 301,
    });

    const regex = toJavaScriptRegex(redirect.regex as string);
    for (const path of ['/', '/lavoro/x/', '/a/b/c.js', '/_x']) {
      expect(regex.test(path), path).toBe(true);
    }
    for (const path of ['/__/auth/handler', '/__/firebase/init.json']) {
      expect(regex.test(path), path).toBe(false);
    }
  });
});
