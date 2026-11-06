import { describe, expect, it } from 'vitest';
import { stripComments } from './helpers/senders';

describe('sender source comment boundaries', () => {
  it('does not open a block from a glob inside a line comment', () => {
    const source = "// job_alert_subscribers/*/alerts/*\nconst selected = db.collectionGroup('alerts');\ncatcher(); /* later explanation */";
    const code = stripComments(source);
    expect(code).toContain("db.collectionGroup('alerts')");
    expect(code).toContain('catcher()');
    expect(code).not.toContain('job_alert_subscribers');
    expect(code).not.toContain('later explanation');
  });

  it('does not accept a gate that appears only in comments', () => {
    const source = "/* hasSubscriptionBasis(); */\n// collectionGroup('alerts')\nfunction send() { /* sendEmailCascade(); */ return false; }";
    const code = stripComments(source);
    expect(code).not.toMatch(/hasSubscriptionBasis|collectionGroup|sendEmailCascade/);
    expect(code).toContain('return false');
  });

  it('preserves comment-like text in URLs, strings, regex and templates', () => {
    const source = 'const url = "https://example.invalid/path/*/"; const rx = /https?:\\/\\//; const tpl = `/* text */ ${1 /* note */ + 2}`;';
    const code = stripComments(source);
    expect(code).toContain('"https://example.invalid/path/*/"');
    expect(code).toContain('/https?:\\/\\//');
    expect(code).toContain('`/* text */ ${1');
    expect(code).not.toContain('note');
    expect(code.split('\n')).toHaveLength(source.split('\n').length);
  });
});
