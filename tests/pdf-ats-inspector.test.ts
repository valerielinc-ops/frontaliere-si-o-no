import { describe, expect, it } from 'vitest';
import {
  auditCvTextLayer,
  buildKeywordCoverageMatrix,
  checkAsciiDates,
  verifyLiteralContacts,
} from '../functions/src/lib/pdfAtsInspector.js';

describe('pdfAtsInspector', () => {
  it('detects Unicode en-dashes in date ranges and flags them for ATS normalization', () => {
    // Unicode en-dash (\u2013) between years
    const textWithEnDash = `
      Esperienza Lavorativa:
      Senior Developer | 2018\u20132023 | Lugano
      Junior Analyst | 2015\u20132018 | Como
    `;
    const checkBad = checkAsciiDates(textWithEnDash);
    expect(checkBad.valid).toBe(false);
    expect(checkBad.hits.length).toBe(2);
    expect(checkBad.hits[0].codePoint).toBe('U+2013');

    // Clean ASCII hyphen date range
    const textClean = `
      Esperienza Lavorativa:
      Senior Developer | 2018-2023 | Lugano
      Junior Analyst | 2015-present | Como
    `;
    const checkGood = checkAsciiDates(textClean);
    expect(checkGood.valid).toBe(true);
    expect(checkGood.hits.length).toBe(0);
  });

  it('verifies literal extraction of email and phone without PUA glyphs', () => {
    const textGood = `
      Marco Bianchi
      Email: marco.bianchi@example.ch
      Telefono: +41 91 123 45 67
      Competenze: TypeScript, React
    `;
    const resGood = verifyLiteralContacts(textGood, {
      email: 'marco.bianchi@example.ch',
      phone: '+41 91 123 45 67',
    });
    expect(resGood.valid).toBe(true);
    expect(resGood.emailFound).toBe(true);
    expect(resGood.phoneFound).toBe(true);
    expect(resGood.puaDetected).toBe(false);

    // With Private Use Area character (\uE001 icon glyph)
    const textPua = `
      Marco Bianchi \uE001 marco.bianchi@example.ch
      Telefono: +41 91 123 45 67
    `;
    const resPua = verifyLiteralContacts(textPua, {
      email: 'marco.bianchi@example.ch',
      phone: '+41 91 123 45 67',
    });
    expect(resPua.valid).toBe(false);
    expect(resPua.puaDetected).toBe(true);
  });

  it('builds honest keyword coverage matrix (covered, synonym, missing_profile, missing_gap)', () => {
    const cvText = `
      Ingegnere del software specializzato in TypeScript, React e containerizzazione Docker.
      Progetti con database relazionali PostgreSQL.
    `;
    const postingKeywords = ['TypeScript', 'React', 'Docker', 'PostgreSQL', 'Kubernetes', 'Golang'];
    const profile = {
      skills: ['TypeScript', 'React', 'Docker', 'PostgreSQL', 'Kubernetes'], // Has K8s in profile but omitted from CV text
    };

    const res = buildKeywordCoverageMatrix(cvText, postingKeywords, profile);
    expect(res.totalKeywords).toBe(6);

    const ts = res.matrix.find((m) => m.keyword === 'TypeScript');
    expect(ts?.status).toBe('covered');

    const k8s = res.matrix.find((m) => m.keyword === 'Kubernetes');
    expect(k8s?.status).toBe('missing_profile'); // In profile, missing from text

    const go = res.matrix.find((m) => m.keyword === 'Golang');
    expect(go?.status).toBe('missing_gap'); // Real gap

    expect(res.scorePercent).toBeGreaterThanOrEqual(60);
  });

  it('conducts end-to-end ATS audit on CV text layer', () => {
    const cvText = `
      Mario Rossi
      Email: mario.rossi@example.com
      Telefono: +39 333 1234567
      Sviluppatore Full-Stack (2019-2024)
      Competenze: TypeScript, React, Node.js, SQL, Docker
    `;
    const audit = auditCvTextLayer({
      cvText,
      contacts: { email: 'mario.rossi@example.com', phone: '+39 333 1234567' },
      postingKeywords: ['TypeScript', 'React', 'Docker', 'SQL'],
      profile: { skills: ['TypeScript', 'React', 'Docker', 'SQL'] },
    });

    expect(audit.passesAts).toBe(true);
    expect(audit.asciiDates.valid).toBe(true);
    expect(audit.literalContacts.valid).toBe(true);
    expect(audit.keywordCoverage.scorePercent).toBe(100);
  });
});
