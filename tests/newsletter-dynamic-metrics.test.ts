import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

describe('loadDashboardMetrics', () => {
  it('unemployment data file exists and has valid rate', () => {
    const filePath = path.join(ROOT, 'public', 'data', 'switzerland-unemployment-rate.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.rate).toBeTypeOf('number');
    expect(data.rate).toBeGreaterThan(0);
    expect(data.rate).toBeLessThan(20);
  });

  it('health premiums data file exists and has Lugano premiums', () => {
    const filePath = path.join(ROOT, 'data', 'health-premiums.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.year).toBeTypeOf('number');
    expect(data.premiums['6823-Lugano']).toBeDefined();
    expect(data.premiums['6823-Lugano'].canton).toBe('TI');
  });

  it('newsletter-content.mjs exports loadDashboardMetrics', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-content.mjs'), 'utf-8');
    expect(content).toContain('export function loadDashboardMetrics');
  });

  it('newsletter-template.mjs renderMetrics accepts metrics parameter', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-template.mjs'), 'utf-8');
    expect(content).toContain('renderMetrics(totalJobs, metrics)');
  });

  it('newsletter-template.mjs does NOT contain hardcoded CHF 412', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-template.mjs'), 'utf-8');
    expect(content).not.toContain('CHF 412');
  });

  it('newsletter-template.mjs does NOT contain hardcoded 2.1%', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-template.mjs'), 'utf-8');
    expect(content).not.toContain('>2.1%<');
  });

  it('send-newsletter.mjs calls loadDashboardMetrics', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts', 'send-newsletter.mjs'), 'utf-8');
    expect(content).toContain('loadDashboardMetrics');
  });

  it('newsletter-qa.mjs passes metrics to buildNewsletter', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts', 'newsletter-qa.mjs'), 'utf-8');
    expect(content).toContain('loadDashboardMetrics');
  });
});

describe('newsletter article header images', () => {
  it('article header emoji uses large font size (>=48px)', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-template.mjs'), 'utf-8');
    const match = content.match(/font-size:(\d+)px[^}]*?\$\{emoji\}/s);
    expect(match).toBeTruthy();
    expect(parseInt(match![1])).toBeGreaterThanOrEqual(48);
  });

  it('article header has adequate height for emoji display', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-template.mjs'), 'utf-8');
    // Match the specific article header div (width:100%;height:NNNpx;background:linear-gradient)
    const match = content.match(/width:100%;height:(\d+)px;background:linear-gradient/);
    expect(match).toBeTruthy();
    expect(parseInt(match![1])).toBeGreaterThanOrEqual(160);
  });
});

describe('newsletter job selection defaults', () => {
  it('send-newsletter.mjs requests 4 jobs per subscriber', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts', 'send-newsletter.mjs'), 'utf-8');
    const calls = content.match(/matchJobsForSubscriber\([^)]+\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain(', 4');
    }
  });

  it('newsletter-content.mjs quality gate requires 120+ chars', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-content.mjs'), 'utf-8');
    expect(content).toContain('120');
    expect(content).toContain('passesQualityGate');
  });
});
