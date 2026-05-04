import { describe, it, expect } from 'vitest';
import { parseDetailPage } from '../scripts/lib/sintetica-job-parser.mjs';

describe('parseDetailPage — closed-position detection', () => {
  it('flags closed=true on Italian "Siamo spiacenti" page', () => {
    const html = `<html><body><h1>Sintetica</h1>
      <div>Siamo spiacenti, la posizione "Front Desk &amp; Office Support (50 - 70%) - Mendrisio site (Ticino)" risulta essere chiusa o non disponibile.
      Non è più possibile inoltrare altre candidature.</div>
    </body></html>`;
    const result = parseDetailPage(html);
    expect(result.closed).toBe(true);
  });

  it('flags closed=true on English "Position closed" page', () => {
    const html = `<html><body><h1>Sintetica</h1>
      <main>This position is closed and no longer available.</main>
    </body></html>`;
    const result = parseDetailPage(html);
    expect(result.closed).toBe(true);
  });

  it('returns closed=false for an open job page', () => {
    const html = `<html><body><h1>Clinical Project Manager</h1>
      <main>Founded in 1921 and headquartered in Mendrisio (Switzerland), Sintetica's
      mission is to continuously strive to improve therapies. The Clinical Project
      Manager will lead studies and contribute to the development of innovative
      pharmaceutical products at our Mendrisio site.</main>
    </body></html>`;
    const result = parseDetailPage(html);
    expect(result.closed).toBe(false);
    expect(result.body.length).toBeGreaterThan(100);
  });

  it('returns closed=false on empty / malformed input', () => {
    expect(parseDetailPage('').closed).toBe(false);
    expect(parseDetailPage('<html><body></body></html>').closed).toBe(false);
  });
});
