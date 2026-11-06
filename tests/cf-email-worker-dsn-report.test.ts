import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error — Cloudflare Worker module, no types
import worker, { isDeliveryStatusReport, classifyDeliveryStatusReport, parseDeliveryStatusReport } from '../infra/cloudflare-email-worker/stop-reply-handler.js';

// Delivery reports (RFC 3464 bounces) arriving as INBOUND MAIL.
//
// Maileroo's return_path for frontaliereticino.ch is a local part on our own
// domain and the zone MX are Cloudflare Email Routing, so an ISP that accepts a
// message at SMTP time and rejects it afterwards reports the failure to this
// worker and never to the ESP. The fixture below is the real Swisscom/Bluewin
// report received 2026-08-21 for campaign weekly_2026-08-17, trimmed only in
// the repeated prose: everything the parser reads is byte-faithful, INCLUDING
// the two traits that break a naive parser —
//   * the message/delivery-status part is EMPTY (no Final-Recipient, no
//     Status), so the recipient can only come from the quoted headers;
//   * the report's own `To:` is our abuse@ address, which must never be
//     mistaken for the bounced subscriber.

const BOUNDARY = '------------I305M09060309060P_559617873124640';

const SWISSCOM_REPORT = [
  'Return-Path: <>',
  'From: noreply@bluewin.ch',
  'To: abuse@frontaliereticino.ch',
  'Subject: Delivery Status Notification',
  'MIME-Version: 1.0',
  `Content-Type: multipart/report; boundary="${BOUNDARY.slice(2)}"`,
  '',
  `--${BOUNDARY.slice(2)}`,
  'Content-Type: text/plain; charset=UTF-8;',
  'Content-Transfer-Encoding: 8bit',
  '',
  'Diese Nachricht wurde automatisch erstellt.',
  'Ihre E-Mail hat folgende Empfängeradresse nicht erreicht:',
  '   * jorgeromero@bluewin.ch',
  'Der Grund für diese Abweisung kann eine falsch eingegebene Adresse, ein',
  'nicht existierendes Mailkonto, ein volles Postfach oder ein temporärer',
  'Fehler auf der Empfängerseite sein.',
  '',
  // The real report repeats the same block in fr/it/en; padded here so the
  // quoted headers sit past the 8 KB the STOP path reads.
  'x'.repeat(6000),
  '',
  `--${BOUNDARY.slice(2)}`,
  'Content-Type: message/delivery-status; charset=UTF-8;',
  'Content-Transfer-Encoding: 8bit',
  '',
  '',
  `--${BOUNDARY.slice(2)}`,
  'Content-Type: text/rfc822-headers',
  'Content-Transfer-Encoding: 8bit',
  'Content-Disposition: attachment',
  '',
  'Received: from mta20.maileroo.com ([85.204.106.2])',
  '    by mailin-012.p.bluenet.ch Swisscom AG with ESMTPS',
  'X-Tag-source_channel: auth_linkedin',
  'List-ID: Frontaliere Weekly <weekly.frontaliereticino.ch>',
  'From: Frontaliere Ticino <newsletter@frontaliereticino.ch>',
  'To: jorgeromero@bluewin.ch',
  'Message-ID: <667058770223026165899480.4841.202682111410@frontaliereticino.ch>',
  'Subject: =?utf-8?q?=F0=9F=93=8A_Grenzg=C3=A4nger?=',
  'X-Tag-campaign_id: weekly_2026-08-17',
  'X-Campaign-Id: weekly_2026-08-17',
  '',
  `--${BOUNDARY.slice(2)}--`,
].join('\n');

// A textbook RFC 3464 report, for the path where the machine-readable part is
// actually populated.
const RFC3464_REPORT = [
  'From: MAILER-DAEMON@mx.example.net',
  'To: abuse@frontaliereticino.ch',
  'Subject: Undeliverable: your message',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
  '',
  '--b1',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mx.example.net',
  'Final-Recipient: rfc822; mario.rossi@example.net',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 <mario.rossi@example.net>: Recipient address',
  ' rejected: User unknown in local recipient table',
  '',
  '--b1',
  'Content-Type: text/rfc822-headers',
  '',
  'To: mario.rossi@example.net',
  'X-Campaign-Id: weekly_2026-08-17',
  '',
  '--b1--',
].join('\n');

// Adversarial case flagged by review on #6256 (tracked as #6264): a human
// reply relayed through a non-conformant gateway that blanks the envelope
// sender (Return-Path: <>), with a subject that happens to read like a
// bounce, AND — the concrete way the quoted-headers fallback could be
// tricked — a "forward as attachment" (message/rfc822) of the original
// outreach mail, whose own `To:` is the company's real inbox. Top-level
// Content-Type is multipart/mixed, never multipart/report, so this must
// classify as 'ambiguous', not 'confirmed'.
const HUMAN_FORWARD_WITH_ATTACHMENT = [
  'Return-Path: <>',
  'From: assistente@azienda.ch',
  'To: abuse@frontaliereticino.ch',
  'Subject: Mancata consegna del pacco, vi preghiamo di rimuoverci dalla lista',
  'MIME-Version: 1.0',
  `Content-Type: multipart/mixed; boundary="${BOUNDARY.slice(2)}"`,
  '',
  `--${BOUNDARY.slice(2)}`,
  'Content-Type: text/plain; charset=UTF-8',
  '',
  'Buongiorno, in allegato la mail che ci era arrivata per errore. Non contattateci più.',
  '',
  `--${BOUNDARY.slice(2)}`,
  'Content-Type: message/rfc822',
  'Content-Disposition: attachment',
  '',
  'From: Frontaliere Ticino <valerie@frontaliereticino.ch>',
  'To: info@azienda.ch',
  'Subject: Collaborazione con Frontaliere Ticino',
  '',
  'Testo originale della nostra mail di outreach.',
  '',
  `--${BOUNDARY.slice(2)}--`,
].join('\n');

function fakeMessage({ from, to, subject, rawText = '', headers = {} }: { from: string; to: string; subject: string; rawText?: string; headers?: Record<string, string> }) {
  const bytes = new TextEncoder().encode(rawText);
  const headerMap = new Map(Object.entries({ subject, ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    from,
    to,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) },
    raw: {
      getReader() {
        let offset = 0;
        return {
          async read() {
            if (offset >= bytes.length) return { done: true, value: undefined };
            // Chunked like a real stream, so a parser that assumes one read fails here.
            const chunk = bytes.slice(offset, offset + 4096);
            offset += chunk.length;
            return { done: false, value: chunk };
          },
          releaseLock() {},
        };
      },
    },
    forward: vi.fn().mockResolvedValue(undefined),
  };
}

const fakeCtx = () => ({ waitUntil: (_p: Promise<unknown>) => {} });

const ENV = {
  STOP_SECRET: 'shared-test-secret',
  FORWARD_TO: 'human@example.com',
  BOUNCE_REPORT_FN_URL: 'https://fn.example/inboundBounceReport',
  NEWSLETTER_ADDRESS: 'newsletter@frontaliereticino.ch',
  OUTREACH_ADDRESS: 'valerie@frontaliereticino.ch',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isDeliveryStatusReport', () => {
  const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] });

  it('matches multipart/report even without the RFC 6522 report-type parameter', () => {
    // Swisscom omits report-type; keying on it would miss the real traffic.
    expect(isDeliveryStatusReport(
      headers({ 'content-type': 'multipart/report; boundary="x"' }),
      'noreply@bluewin.ch',
      'Delivery Status Notification',
    )).toBe(true);
  });

  it('matches a daemon sender with a bounce subject when the content-type is plain', () => {
    expect(isDeliveryStatusReport(
      headers({ 'content-type': 'text/plain' }),
      'MAILER-DAEMON@mx.example.net',
      'Undeliverable: your message',
    )).toBe(true);
    expect(isDeliveryStatusReport(
      headers({ 'content-type': 'text/plain' }),
      'postmaster@mx.example.net',
      'Messaggio non recapitato',
    )).toBe(true);
  });

  it('does not match a human reply that merely talks about delivery', () => {
    expect(isDeliveryStatusReport(
      headers({ 'content-type': 'text/plain' }),
      'anna@azienda.ch',
      'Re: delivery failed on our side?',
    )).toBe(false);
    // Daemon address alone is not enough — plenty of legitimate mail is sent
    // from noreply@.
    expect(isDeliveryStatusReport(
      headers({ 'content-type': 'text/plain' }),
      'noreply@partner.ch',
      'La tua ricevuta di agosto',
    )).toBe(false);
  });
});

describe('classifyDeliveryStatusReport', () => {
  const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] });

  it('is confirmed for multipart/report and for a daemon sender with a bounce subject', () => {
    expect(classifyDeliveryStatusReport(
      headers({ 'content-type': 'multipart/report; boundary="x"' }),
      '',
      'Delivery Status Notification',
    )).toBe('confirmed');
    expect(classifyDeliveryStatusReport(
      headers({ 'content-type': 'text/plain' }),
      'MAILER-DAEMON@mx.example.net',
      'Undeliverable: your message',
    )).toBe('confirmed');
  });

  it('is only ambiguous for an empty envelope sender with a coincidental subject match', () => {
    // The exact adversarial case from review on #6256 (#6264): blank
    // Return-Path (non-conformant relay) + a subject that merely happens to
    // read like a bounce, no multipart/report structure.
    expect(classifyDeliveryStatusReport(
      headers({ 'content-type': 'multipart/mixed; boundary="x"' }),
      '',
      'Mancata consegna del pacco, vi preghiamo di rimuoverci dalla lista',
    )).toBe('ambiguous');
  });

  it('is none for an empty sender whose subject does not match', () => {
    expect(classifyDeliveryStatusReport(
      headers({ 'content-type': 'text/plain' }),
      '',
      'Ciao, possiamo sentirci domani?',
    )).toBe('none');
  });
});

describe('parseDeliveryStatusReport', () => {
  it('reads the bounced address from the quoted headers when delivery-status is empty', () => {
    const report = parseDeliveryStatusReport(SWISSCOM_REPORT);
    expect(report.recipient).toBe('jorgeromero@bluewin.ch');
    expect(report.campaignId).toBe('weekly_2026-08-17');
    expect(report.originalMessageId).toBe('<667058770223026165899480.4841.202682111410@frontaliereticino.ch>');
    // No machine-readable code anywhere in this report — the classifier must be
    // told that honestly rather than handed an invented one.
    expect(report.status).toBe('');
    expect(report.diagnosticCode).toBe('');
  });

  it('never attributes the bounce to our own address', () => {
    // The report's own To: is abuse@frontaliereticino.ch; a parser that reads
    // the first To: it finds would suppress our own mailbox.
    expect(parseDeliveryStatusReport(SWISSCOM_REPORT).recipient).not.toContain('frontaliereticino.ch');
    const selfAddressed = SWISSCOM_REPORT.replace('To: jorgeromero@bluewin.ch', 'To: abuse@frontaliereticino.ch');
    expect(parseDeliveryStatusReport(selfAddressed).recipient).toBe('');
  });

  it('prefers Final-Recipient and keeps Status, Action and the folded Diagnostic-Code', () => {
    const report = parseDeliveryStatusReport(RFC3464_REPORT);
    expect(report.recipient).toBe('mario.rossi@example.net');
    expect(report.status).toBe('5.1.1');
    expect(report.action).toBe('failed');
    expect(report.diagnosticCode).toContain('550 5.1.1');
    // Folded continuation line joined, not truncated at the newline.
    expect(report.diagnosticCode).toContain('User unknown in local recipient table');
    expect(report.reportingMta).toBe('mx.example.net');
  });

  it('returns an empty recipient rather than guessing from the prose', () => {
    // The German block lists "* jorgeromero@bluewin.ch" in running text. With
    // the quoted-headers part gone there is no trustworthy source, and the
    // caller must forward to a human instead of suppressing someone.
    const withoutQuoted = SWISSCOM_REPORT.split('Content-Type: text/rfc822-headers')[0];
    expect(parseDeliveryStatusReport(withoutQuoted).recipient).toBe('');
  });

  it('requireExplicitRecipient ignores the quoted-headers To: fallback', () => {
    // Without the guard, a "forward as attachment" of our own outreach mail
    // would have ITS To: read as a bounced recipient — the exact gap flagged
    // by review on #6256 (#6264).
    expect(parseDeliveryStatusReport(HUMAN_FORWARD_WITH_ATTACHMENT).recipient).toBe('info@azienda.ch');
    expect(parseDeliveryStatusReport(
      HUMAN_FORWARD_WITH_ATTACHMENT, undefined, { requireExplicitRecipient: true },
    ).recipient).toBe('');
    // A genuine explicit Final-Recipient field is still trusted even under
    // the stricter mode — real RFC 3464 reports use it.
    expect(parseDeliveryStatusReport(
      RFC3464_REPORT, undefined, { requireExplicitRecipient: true },
    ).recipient).toBe('mario.rossi@example.net');
  });
});

describe('worker email() — delivery report branch', () => {
  it('POSTs the parsed report and does not forward it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const message = fakeMessage({
      from: 'noreply@bluewin.ch',
      to: 'abuse@frontaliereticino.ch',
      subject: 'Delivery Status Notification',
      rawText: SWISSCOM_REPORT,
      headers: { 'content-type': 'multipart/report; boundary="x"' },
    });

    await worker.email(message, ENV, fakeCtx());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ENV.BOUNCE_REPORT_FN_URL);
    expect(init.headers['x-stop-secret']).toBe(ENV.STOP_SECRET);
    expect(JSON.parse(init.body)).toMatchObject({
      recipient: 'jorgeromero@bluewin.ch',
      campaignId: 'weekly_2026-08-17',
    });
    // An attributed, accepted report is handled — forwarding it too would put
    // the noise back in the inbox this fixes.
    expect(message.forward).not.toHaveBeenCalled();
  });

  it('runs before the auto-reply filter, so a conforming report is not dropped unread', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const message = fakeMessage({
      from: 'MAILER-DAEMON@mx.example.net',
      to: 'abuse@frontaliereticino.ch',
      subject: 'Undeliverable: your message',
      rawText: RFC3464_REPORT,
      // RFC 3464 reports routinely carry this; isAutoReply would drop them.
      headers: { 'content-type': 'multipart/report; report-type=delivery-status', 'auto-submitted': 'auto-replied' },
    });

    await worker.email(message, ENV, fakeCtx());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      recipient: 'mario.rossi@example.net',
      status: '5.1.1',
    });
  });

  it('forwards the report when it cannot be attributed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const message = fakeMessage({
      from: 'noreply@bluewin.ch',
      to: 'abuse@frontaliereticino.ch',
      subject: 'Delivery Status Notification',
      rawText: SWISSCOM_REPORT.split('Content-Type: text/rfc822-headers')[0],
      headers: { 'content-type': 'multipart/report; boundary="x"' },
    });

    await worker.email(message, ENV, fakeCtx());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.forward).toHaveBeenCalledWith(ENV.FORWARD_TO);
  });

  it('forwards the report when the endpoint rejects it, so no signal is lost', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);
    const message = fakeMessage({
      from: 'noreply@bluewin.ch',
      to: 'abuse@frontaliereticino.ch',
      subject: 'Delivery Status Notification',
      rawText: SWISSCOM_REPORT,
      headers: { 'content-type': 'multipart/report; boundary="x"' },
    });

    await worker.email(message, ENV, fakeCtx());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(message.forward).toHaveBeenCalledWith(ENV.FORWARD_TO);
  });

  it('forwards a human forward-as-attachment reply instead of mis-suppressing its attached recipient', async () => {
    // Ambiguous DSN classification (blank envelope sender + coincidental
    // subject) must NOT let the quoted message/rfc822 attachment's own To:
    // be read as a bounced address and swallowed (#6264).
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const message = fakeMessage({
      from: '',
      to: 'abuse@frontaliereticino.ch',
      subject: 'Mancata consegna del pacco, vi preghiamo di rimuoverci dalla lista',
      rawText: HUMAN_FORWARD_WITH_ATTACHMENT,
      headers: { 'content-type': 'multipart/mixed; boundary="x"' },
    });

    await worker.email(message, ENV, fakeCtx());

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).not.toContain(ENV.BOUNCE_REPORT_FN_URL);
    expect(message.forward).toHaveBeenCalledWith(ENV.FORWARD_TO);
  });

  it('leaves an ordinary reply on the existing outreach path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const message = fakeMessage({
      from: 'anna@azienda.ch',
      to: 'valerie@frontaliereticino.ch',
      subject: 'Re: la vostra proposta',
      rawText: 'Buongiorno, ci pensiamo.',
      headers: { 'content-type': 'text/plain' },
    });

    await worker.email(message, ENV, fakeCtx());

    // Reply tracking still fires; the bounce endpoint must not.
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).not.toContain(ENV.BOUNCE_REPORT_FN_URL);
    expect(message.forward).toHaveBeenCalledWith(ENV.FORWARD_TO);
  });
});
