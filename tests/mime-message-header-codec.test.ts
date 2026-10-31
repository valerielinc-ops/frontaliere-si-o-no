import { describe, expect, it } from 'vitest';
import { decodeEncodedWords, parseMimeMessage } from '../functions/src/lib/mimeMessage.js';

function base64Word(value: string, charset = 'UTF-8') {
  return `=?${charset}?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function quotedPrintableWord(value: string) {
  const bytes = Buffer.from(value, 'utf8');
  const encoded = [...bytes].map((byte) => {
    if (byte === 0x20) return '_';
    if (byte >= 0x21 && byte <= 0x7e && ![0x3d, 0x3f, 0x5f].includes(byte)) return String.fromCharCode(byte);
    return `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
  return `=?UTF-8?Q?${encoded}?=`;
}

describe('RFC 2047 MIME header codec', () => {
  it('joins only adjacent encoded-word folding and preserves encoded spaces and Unicode', () => {
    const words = [
      base64Word('Andrea '),
      quotedPrintableWord('Rossi – Zürich 🌍'),
      base64Word(' / Réunion / Bewerbung / Città'),
    ];

    expect(decodeEncodedWords(`${words[0]}\r\n\t${words[1]}\r\n ${words[2]}`))
      .toBe('Andrea Rossi – Zürich 🌍 / Réunion / Bewerbung / Città');
    expect(decodeEncodedWords(`prefisso ${base64Word('Andrea')} testo ${quotedPrintableWord('Rossi')}`))
      .toBe('prefisso Andrea testo Rossi');
    expect(decodeEncodedWords(quotedPrintableWord('Andrea Rossi'))).toBe('Andrea Rossi');
  });

  it('keeps MIME parsing, case-insensitive headers, body and attachment boundaries intact', () => {
    const boundary = 'synthetic-mime-boundary';
    const subject = [
      base64Word('Candidatura: '),
      quotedPrintableWord('Andrea Rossi – Zürich; '),
      base64Word('Bewerbung / Réunion / Città 🌍; '),
      quotedPrintableWord('Résumé finale'),
    ];
    const expectedSubject = 'Candidatura: Andrea Rossi – Zürich; Bewerbung / Réunion / Città 🌍; Résumé finale';
    expect(expectedSubject.length).toBeGreaterThan(75);
    const attachment = Buffer.from('synthetic attachment');
    const raw = Buffer.from([
      `fRoM: ${base64Word('Andrea ')}\r\n\t${quotedPrintableWord('Rossi – Zürich 🌍')} <robot@example.test>`,
      `sUbJeCt: ${subject[0]}\r\n\t${subject[1]}\r\n\t${subject[2]}\r\n\t${subject[3]}`,
      'MIME-Version: 1.0',
      `cOnTeNt-TyPe: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'cOnTeNt-TyPe: text/plain; charset=UTF-8',
      '',
      'Synthetic message body.',
      `--${boundary}`,
      'cOnTeNt-TyPe: application/octet-stream; name="fixture.bin"',
      'cOnTeNt-TrAnSfEr-EnCoDiNg: base64',
      'cOnTeNt-DiSpOsItIoN: ATTACHMENT; filename="fixture.bin"',
      '',
      attachment.toString('base64'),
      `--${boundary}--`,
      '',
    ].join('\r\n'), 'latin1');

    const parsed = parseMimeMessage(raw);
    expect(parsed.subject).toBe(expectedSubject);
    expect(parsed.from).toBe('Andrea Rossi – Zürich 🌍 <robot@example.test>');
    expect(parsed.text).toBe('Synthetic message body.');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ filename: 'fixture.bin', contentType: 'application/octet-stream' });
    expect(parsed.attachments[0].content.equals(attachment)).toBe(true);
  });

  it('fails closed for malformed, unknown-charset and control-bearing encoded words', () => {
    const malformed = '=?UTF-8?B?%%%?=';
    const unknownToken = `=?X-unknown-charset?B?${Buffer.from('Andrea', 'utf8').toString('base64')}?=`;
    const unknownCharset = `${unknownToken} =?UTF-8?B?Um9zc2k=?=`;
    const controlBearing = `=?UTF-8?B?${Buffer.from('safe\r\nInjected', 'utf8').toString('base64')}?=`;
    const malformedCharset = `=?x-utf-8-bogus?B?${Buffer.from('é', 'utf8').toString('base64')}?=`;
    const emptyBase64 = '=?UTF-8?B??=';
    const overlong = `=?UTF-8?B?${'A'.repeat(64)}?=`;
    const valid = base64Word('Andrea');

    expect(() => decodeEncodedWords(malformed)).not.toThrow();
    expect(decodeEncodedWords(malformed)).toBe(malformed);
    expect(decodeEncodedWords(unknownCharset)).toBe(`${unknownToken} Rossi`);
    expect(decodeEncodedWords(controlBearing)).toBe(controlBearing);
    expect(decodeEncodedWords(malformedCharset)).toBe(malformedCharset);
    expect(decodeEncodedWords(emptyBase64)).toBe(emptyBase64);
    expect(overlong.length).toBeGreaterThan(75);
    expect(decodeEncodedWords(overlong)).toBe(overlong);
    expect(decodeEncodedWords(`${valid} ${unknownToken}`)).toBe(`Andrea ${unknownToken}`);
    expect(decodeEncodedWords(`${valid}\r\n\t${malformed}`)).toBe(`Andrea\r\n\t${malformed}`);
    expect(decodeEncodedWords(`${valid} ${controlBearing}`)).toBe(`Andrea ${controlBearing}`);
  });

  it('accepts RFC 2231 language-tagged UTF-8 and preserves raw fallback in parsed headers', () => {
    const languageTagged = base64Word('Città', 'UTF-8*it');
    const unknown = '=?X-unknown-charset?B?Qg==?=';
    const malformed = '=?UTF-8?B?%%%?=';

    expect(decodeEncodedWords(languageTagged)).toBe('Città');

    for (const rawWord of [unknown, malformed]) {
      const subject = `${base64Word('Andrea')} ${rawWord}`;
      const parsed = parseMimeMessage(Buffer.from(`Subject: ${subject}\r\n\r\n`, 'latin1'));
      expect(parsed.subject).toBe(`Andrea ${rawWord}`);
    }
  });
});
