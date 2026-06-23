import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types
import { isStopReply, extractSenderEmail, STOP_INTENT_PATTERNS } from '../scripts/lib/stop-reply-detect.mjs';
// @ts-expect-error — plain .mjs helper, no types
import { resolveCompanyKeyByEmail } from '../scripts/lib/outreach-suppression.mjs';
// @ts-expect-error — plain .mjs helper, no types
import { classifyReplies } from '../scripts/process-stop-replies.mjs';

// Auto-suppress from STOP replies (follow-up #2620 item 2). The classifier turns
// "did the recipient ask to be removed" into "suppress this company" — a
// compliance-critical decision (nDSG/CAN-SPAM + sending-domain reputation), so
// over- and under-matching are both real risks worth pinning.
describe('STOP-reply detection', () => {
  it('matches the common opt-out forms (IT + EN)', () => {
    const stops = [
      { subject: 'Re: candidati inviati', body: 'STOP' },
      { subject: 'Re: candidati', body: 'stop.' },
      { subject: 'unsubscribe', body: '' },
      { subject: '', body: 'Per favore rimuovetemi da questa lista.' },
      { subject: '', body: 'cancellatemi grazie' },
      { subject: '', body: 'Vi chiedo di annullare l’iscrizione.' },
      { subject: '', body: 'non scrivetemi più per favore' },
      { subject: '', body: 'remove me from your list' },
      { subject: '', body: 'opt-out' },
      { subject: '', body: 'disiscrivetemi' },
    ];
    for (const r of stops) {
      expect(isStopReply(r), `should be STOP: ${JSON.stringify(r)}`).toBe(true);
    }
  });

  it('does NOT match unrelated replies (no over-suppression)', () => {
    const notStops = [
      { subject: 'Re: candidati inviati', body: 'Grazie, ci pensiamo e vi ricontattiamo.' },
      { subject: 'Interessati', body: 'Quanto costa lo sponsorizzato?' },
      { subject: 'nonstop flights', body: 'parliamo del nostro stopover a Zurigo' },
      { subject: '', body: 'Mi sono già iscritto, tutto ok.' },
      { subject: '', body: '' },
    ];
    for (const r of notStops) {
      expect(isStopReply(r), `should NOT be STOP: ${JSON.stringify(r)}`).toBe(false);
    }
  });

  it('exposes the shared pattern list (kept in sync with the CF copies)', () => {
    expect(Array.isArray(STOP_INTENT_PATTERNS)).toBe(true);
    expect(STOP_INTENT_PATTERNS.length).toBeGreaterThan(5);
  });
});

describe('extractSenderEmail', () => {
  it('pulls the address out of a display-name From header', () => {
    expect(extractSenderEmail('Denise Rossi <Denise@Casale.CH>')).toBe('denise@casale.ch');
  });
  it('accepts a bare address', () => {
    expect(extractSenderEmail('hr@aldi.ch')).toBe('hr@aldi.ch');
  });
  it('returns empty for junk', () => {
    expect(extractSenderEmail('')).toBe('');
    expect(extractSenderEmail('not an email')).toBe('');
  });
});

describe('resolveCompanyKeyByEmail', () => {
  const contacts = {
    'casale-sa': { email: 'denise@casale.ch' },
    'aldi-suisse': { email: '', emailInferred: 'hr@aldi.ch' },
  };
  it('maps a verified address to its companyKey (case-insensitive)', () => {
    expect(resolveCompanyKeyByEmail('DENISE@casale.ch', contacts)).toBe('casale-sa');
  });
  it('maps an inferred address too', () => {
    expect(resolveCompanyKeyByEmail('hr@aldi.ch', contacts)).toBe('aldi-suisse');
  });
  it('returns empty for an unknown sender', () => {
    expect(resolveCompanyKeyByEmail('stranger@elsewhere.com', contacts)).toBe('');
  });
});

describe('classifyReplies (queue → suppression decisions)', () => {
  const contacts = {
    'casale-sa': { email: 'denise@casale.ch' },
    'aldi-suisse': { email: 'hr@aldi.ch' },
  };

  it('suppresses only STOP replies from known senders, deduped', () => {
    const replies = [
      { from: 'Denise <denise@casale.ch>', subject: 'Re: candidati', body: 'STOP' },
      { from: 'denise@casale.ch', subject: 'Re: candidati', body: 'stop di nuovo' }, // dup company
      { from: 'hr@aldi.ch', subject: 'Interessati', body: 'Quanto costa?' }, // not a stop
      { from: 'unknown@x.com', subject: 'unsubscribe', body: '' }, // unknown sender
      { from: '', subject: 'STOP', body: '' }, // no sender
    ];
    const { toSuppress, skipped } = classifyReplies(replies, contacts);
    expect(toSuppress.map((t: any) => t.companyKey)).toEqual(['casale-sa']);
    expect(toSuppress[0].fromEmail).toBe('denise@casale.ch');
    // not-a-stop, unknown-sender, no-sender (the dup is silently merged, not skipped)
    const reasons = skipped.map((s: any) => s.reason).sort();
    expect(reasons).toEqual(['no-sender', 'not-a-stop', 'unknown-sender']);
  });

  it('handles an empty queue', () => {
    const { toSuppress, skipped } = classifyReplies([], contacts);
    expect(toSuppress).toEqual([]);
    expect(skipped).toEqual([]);
  });
});
