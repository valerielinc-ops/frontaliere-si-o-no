/**
 * Unit tests for the shared F5 BIG-IP cookie jar (scripts/lib/tiChCookieJar.mjs),
 * extracted from the inline copies in analyze-webcam-frame / fetch-webcam-snapshots
 * / check-border-data-health. Pins the Set-Cookie parse + Cookie header build so
 * the per-process session-continuity behaviour stays byte-identical to the inline
 * originals.
 *
 * The jar is a module-level singleton; tests clear it in beforeEach so order
 * doesn't matter.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  tiChCookieJar,
  buildCookieHeader,
  updateCookieJar,
} from '../scripts/lib/tiChCookieJar.mjs';

/** Minimal Response stand-in exposing only the getSetCookie() the jar reads. */
const resWith = (setCookies: string[] | undefined) =>
  ({
    headers: {
      getSetCookie: setCookies === undefined ? undefined : () => setCookies,
    },
  }) as unknown as Response;

beforeEach(() => {
  tiChCookieJar.clear();
});

describe('tiChCookieJar', () => {
  it('returns undefined header when the jar is empty', () => {
    expect(buildCookieHeader()).toBeUndefined();
  });

  it('parses name=value from each Set-Cookie, dropping attributes', () => {
    updateCookieJar(
      resWith([
        'BIGipServerpool=abc123; path=/; HttpOnly',
        'TS01abc=def456; Path=/; Secure',
      ]),
    );
    expect(tiChCookieJar.get('BIGipServerpool')).toBe('abc123');
    expect(tiChCookieJar.get('TS01abc')).toBe('def456');
    expect(buildCookieHeader()).toBe('BIGipServerpool=abc123; TS01abc=def456');
  });

  it('keeps a value that itself contains "=" intact (splits on first = only)', () => {
    updateCookieJar(resWith(['dtCookie=v_4_srv_1_sn_AAA==; path=/']));
    expect(tiChCookieJar.get('dtCookie')).toBe('v_4_srv_1_sn_AAA==');
  });

  it('later Set-Cookie for the same name overwrites the earlier value', () => {
    updateCookieJar(resWith(['s=one; path=/']));
    updateCookieJar(resWith(['s=two; path=/']));
    expect(tiChCookieJar.get('s')).toBe('two');
    expect(buildCookieHeader()).toBe('s=two');
  });

  it('tolerates a missing getSetCookie() (older runtimes) without throwing', () => {
    expect(() => updateCookieJar(resWith(undefined))).not.toThrow();
    expect(buildCookieHeader()).toBeUndefined();
  });

  it('ignores malformed cookies with no "=" and leading-"=" names', () => {
    updateCookieJar(resWith(['justaflag', '=novalue', 'ok=1']));
    expect(tiChCookieJar.has('justaflag')).toBe(false);
    expect(tiChCookieJar.has('')).toBe(false);
    expect(tiChCookieJar.get('ok')).toBe('1');
    expect(buildCookieHeader()).toBe('ok=1');
  });
});
