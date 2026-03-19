import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const QA_DIR = path.join(ROOT, 'docs', 'newsletter-qa');
const today = new Date().toISOString().slice(0, 10);

describe('newsletter-qa script', () => {
  it('script file exists and is executable-ish', () => {
    const scriptPath = path.join(ROOT, 'scripts', 'newsletter-qa.mjs');
    expect(fs.existsSync(scriptPath)).toBe(true);
    const content = fs.readFileSync(scriptPath, 'utf8');
    expect(content).toContain('buildNewsletter');
    expect(content).toContain('CHECKS');
    expect(content).toContain('takeScreenshots');
  });

  it('QA report for today was generated and passes', () => {
    const reportPath = path.join(QA_DIR, `${today}-report.json`);
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(report.passed).toBe(true);
    expect(report.checksFailed).toBe(0);
    expect(report.checksTotal).toBeGreaterThan(10);
    expect(report.date).toBe(today);
  });

  it('QA report contains desktop and mobile screenshots', () => {
    const reportPath = path.join(QA_DIR, `${today}-report.json`);
    if (!fs.existsSync(reportPath)) return; // skip if no report yet
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(report.screenshots).toHaveProperty('desktop');
    expect(report.screenshots).toHaveProperty('mobile');
    expect(fs.existsSync(report.screenshots.desktop)).toBe(true);
    expect(fs.existsSync(report.screenshots.mobile)).toBe(true);
  });

  it('QA report HTML is non-trivial', () => {
    const reportPath = path.join(QA_DIR, `${today}-report.json`);
    if (!fs.existsSync(reportPath)) return;
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(report.htmlSizeBytes).toBeGreaterThan(8000);
    expect(report.html).toContain('<!DOCTYPE');
  });
});

describe('newsletter QA gate in send-newsletter.mjs', () => {
  it('send-newsletter.mjs contains enforceQaGate() call in --send path', () => {
    const sendScript = path.join(ROOT, 'scripts', 'send-newsletter.mjs');
    const content = fs.readFileSync(sendScript, 'utf8');
    expect(content).toContain('enforceQaGate');
    expect(content).toContain("mode === 'send'");
    expect(content).toContain('NEWSLETTER_SKIP_QA_GATE');
  });

  it('send-newsletter.mjs gate checks for today QA report', () => {
    const sendScript = path.join(ROOT, 'scripts', 'send-newsletter.mjs');
    const content = fs.readFileSync(sendScript, 'utf8');
    expect(content).toContain('-report.json');
    // Gate must exit(1) if report missing or failed
    expect(content).toContain('process.exit(1)');
  });
});

describe('newsletter QA structural check definitions', () => {
  it('QA script checks for mobile media query', () => {
    const qa = fs.readFileSync(path.join(ROOT, 'scripts', 'newsletter-qa.mjs'), 'utf8');
    expect(qa).toContain('@media only screen and');
  });

  it('QA script checks for absence of <script> tags', () => {
    const qa = fs.readFileSync(path.join(ROOT, 'scripts', 'newsletter-qa.mjs'), 'utf8');
    expect(qa).toContain('no-scripts');
    expect(qa).toContain('<script');
  });

  it('QA script checks for unsubscribe link', () => {
    const qa = fs.readFileSync(path.join(ROOT, 'scripts', 'newsletter-qa.mjs'), 'utf8');
    expect(qa).toContain('unsubscribe-link');
    expect(qa).toContain('action=unsubscribe');
  });

  it('QA script validates table-based layout', () => {
    const qa = fs.readFileSync(path.join(ROOT, 'scripts', 'newsletter-qa.mjs'), 'utf8');
    expect(qa).toContain('table-based-layout');
  });
});
