import { validateEmailStrict, isGibberish, checkMxRecord } from '@/components/shared/EmailInput';
import Mailcheck from 'mailcheck';

/* ------------------------------------------------------------------ */
/*  validateEmailStrict — format + domain heuristics                  */
/* ------------------------------------------------------------------ */

describe('validateEmailStrict', () => {
  it('accepts valid common emails', () => {
    const valid = [
      'user@gmail.com',
      'mario.rossi@outlook.com',
      'frontaliere123@bluewin.ch',
      'ab@libero.it',
    ];
    for (const e of valid) {
      expect(validateEmailStrict(e), e).toEqual({ valid: true });
    }
  });

  it('rejects bad format', () => {
    const bad = ['', 'noat', '@nolocal.com', 'spaces @x.com', 'user@.com'];
    for (const e of bad) {
      expect(validateEmailStrict(e).valid, e).toBe(false);
    }
  });

  it('rejects short local part', () => {
    expect(validateEmailStrict('a@gmail.com').valid).toBe(false);
  });

  it('rejects disposable domains', () => {
    expect(validateEmailStrict('user@mailinator.com')).toEqual({ valid: false, reason: 'disposable' });
    expect(validateEmailStrict('user@yopmail.com')).toEqual({ valid: false, reason: 'disposable' });
  });

  it('rejects spam-pattern domains', () => {
    expect(validateEmailStrict('user@aaaa.com')).toEqual({ valid: false, reason: 'domain_spam' });
  });

  it('rejects numeric-only domains', () => {
    expect(validateEmailStrict('user@123.123').valid).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Mailcheck — typo suggestion (pure logic, no React)                */
/* ------------------------------------------------------------------ */

const MAILCHECK_DOMAINS = [
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com',
  'live.com', 'libero.it', 'virgilio.it', 'tim.it', 'alice.it',
  'tiscali.it', 'fastwebnet.it', 'pec.it', 'aruba.it',
  'protonmail.com', 'proton.me', 'msn.com', 'gmx.com', 'gmx.net',
  'bluewin.ch', 'hispeed.ch', 'sunrise.ch', 'swissonline.ch',
  'yahoo.it', 'outlook.it', 'hotmail.it', 'googlemail.com',
  'aol.com', 'me.com', 'mac.com', 'mail.com', 'email.it',
];

const MAILCHECK_SLDS = [
  'yahoo', 'hotmail', 'mail', 'live', 'outlook', 'gmx',
  'libero', 'virgilio', 'alice', 'tiscali', 'fastwebnet',
  'protonmail', 'proton', 'bluewin', 'sunrise', 'hispeed',
];

const MAILCHECK_TLDS = [
  'com', 'it', 'ch', 'net', 'org', 'de', 'fr', 'eu', 'co.uk',
  'at', 'me', 'io', 'dev',
];

function suggest(email: string): string | null {
  let result: string | null = null;
  Mailcheck.run({
    email,
    domains: MAILCHECK_DOMAINS,
    secondLevelDomains: MAILCHECK_SLDS,
    topLevelDomains: MAILCHECK_TLDS,
    suggested: (s: { full: string }) => { result = s.full; },
    empty: () => { result = null; },
  });
  return result;
}

describe('Mailcheck typo detection', () => {
  it('suggests gmail.com for gmial.com', () => {
    expect(suggest('user@gmial.com')).toBe('user@gmail.com');
  });

  it('suggests gmail.com for gmal.com', () => {
    expect(suggest('user@gmal.com')).toBe('user@gmail.com');
  });

  it('suggests hotmail.com for hotmal.com', () => {
    expect(suggest('user@hotmal.com')).toBe('user@hotmail.com');
  });

  it('suggests outlook.com for outlok.com', () => {
    expect(suggest('user@outlok.com')).toBe('user@outlook.com');
  });

  it('suggests libero.it for livero.it', () => {
    expect(suggest('user@livero.it')).toBe('user@libero.it');
  });

  it('suggests bluewin.ch for bluwin.ch', () => {
    expect(suggest('user@bluwin.ch')).toBe('user@bluewin.ch');
  });

  it('returns null for correct email', () => {
    expect(suggest('user@gmail.com')).toBeNull();
  });

  it('returns null for known correct domains', () => {
    expect(suggest('mario@outlook.com')).toBeNull();
    expect(suggest('mario@bluewin.ch')).toBeNull();
    expect(suggest('mario@libero.it')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  isGibberish — keyboard mashing / random string detection          */
/* ------------------------------------------------------------------ */

describe('isGibberish', () => {
  it('detects keyboard mashing patterns', () => {
    expect(isGibberish('qwerty')).toBe(true);
    expect(isGibberish('asdfgh')).toBe(true);
    expect(isGibberish('zxcvbn')).toBe(true);
    expect(isGibberish('qwertyuiop')).toBe(true);
  });

  it('detects consonant-heavy strings', () => {
    expect(isGibberish('bcdfghjk')).toBe(true);
    expect(isGibberish('xzqwrtpl')).toBe(true);
  });

  it('accepts real names and words', () => {
    expect(isGibberish('mario')).toBe(false);
    expect(isGibberish('giuseppe')).toBe(false);
    expect(isGibberish('frontaliere')).toBe(false);
    expect(isGibberish('newsletter')).toBe(false);
    expect(isGibberish('contact')).toBe(false);
    expect(isGibberish('rossi')).toBe(false);
    expect(isGibberish('mariorossi')).toBe(false);
  });

  it('accepts short strings without checking', () => {
    expect(isGibberish('ab')).toBe(false);
    expect(isGibberish('xyz')).toBe(false);
    expect(isGibberish('test')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  validateEmailStrict — gibberish rejection                         */
/* ------------------------------------------------------------------ */

describe('validateEmailStrict gibberish check', () => {
  it('rejects gibberish local parts', () => {
    expect(validateEmailStrict('qwertyui@gmail.com')).toEqual({ valid: false, reason: 'gibberish' });
    expect(validateEmailStrict('asdfghjk@outlook.com')).toEqual({ valid: false, reason: 'gibberish' });
  });

  it('accepts normal emails through gibberish check', () => {
    expect(validateEmailStrict('mario.rossi@gmail.com')).toEqual({ valid: true });
    expect(validateEmailStrict('frontaliere@bluewin.ch')).toEqual({ valid: true });
    expect(validateEmailStrict('contact123@outlook.com')).toEqual({ valid: true });
  });
});

/* ------------------------------------------------------------------ */
/*  checkMxRecord — DNS MX lookup via dns.google                      */
/* ------------------------------------------------------------------ */

describe('checkMxRecord', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true for domain with MX records', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Status: 0, Answer: [{ type: 15, data: '10 mail.example.com.' }] }),
    } as Response);
    expect(await checkMxRecord('example.com')).toBe(true);
  });

  it('returns false for NXDOMAIN (Status 3)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Status: 3 }),
    } as Response);
    expect(await checkMxRecord('nonexistent-domain-xyz.invalid')).toBe(false);
  });

  it('returns false when no Answer array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Status: 0 }),
    } as Response);
    expect(await checkMxRecord('no-mx-domain.test')).toBe(false);
  });

  it('fails open on network error (returns true)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'));
    expect(await checkMxRecord('any-domain.com')).toBe(true);
  });
});
