import { describe, expect, it } from 'vitest';

import {
  classifyHasHealthcareDiscovery,
  parseListingPage,
} from '../scripts/update-has-healthcare-jobs.mjs';

describe('HAS Healthcare crawler discovery', () => {
  it('parses the e-lavoro listing card shape', () => {
    const html = `
      <div class="job-card">
        <span class="job-title-row">Assistente di Produzione</span>
        <span class="rounded-pill main-list-job-percentage">100%</span>
        <time class="datetime">01.07.26</time>
        <a href="/node/276" target="_self" class="w-100 p-3">
          <span class="main-list-job-button-view">Visualizza annuncio</span>
        </a>
      </div>
    `;

    expect(parseListingPage(html)).toEqual([
      {
        title: 'Assistente di Produzione',
        detailUrl: 'https://e-lavoro.ch/node/276',
        percentage: '100%',
        dateStr: '01.07.26',
      },
    ]);
  });

  it('survives portal attribute reordering, extra classes, absolute URLs and label drift', () => {
    const html = `
      <section class="job-card has-extra-layout-class">
        <span class="job-title-row text-body">Production Manager</span>
        <time data-source="published" class="datetime">21.11.25</time>
        <span class="main-list-job-percentage rounded-pill">100% full time</span>
        <a class="stretched-link view-posting" target="_self" href="https://www.e-lavoro.ch/node/264">
          <span class="icon main-list-job-button-view">View posting</span>
        </a>
      </section>
    `;

    expect(parseListingPage(html)).toEqual([
      {
        title: 'Production Manager',
        detailUrl: 'https://e-lavoro.ch/node/264',
        percentage: '100% full time',
        dateStr: '21.11.25',
      },
    ]);
  });

  it('falls back to a bounded node link when the portal renames the action classes', () => {
    const html = `
      <div class="job-card">
        <span class="renamed-title-class">Assistente di Produzione</span>
        <a href="/node/276" class="new-action-class">View job</a>
      </div>
      <footer><a href="/node/75">Login</a><a href="/node/76">Published Announcements</a></footer>
    `;

    expect(parseListingPage(html)).toEqual([
      {
        title: 'Assistente di Produzione',
        detailUrl: 'https://e-lavoro.ch/node/276',
        percentage: '',
        dateStr: '',
      },
    ]);
  });

  it('keeps a long title when it has the explicit job-title marker', () => {
    const title = 'A'.repeat(161);
    const html = `
      <div class="job-card">
        <span class="job-title-row">${title}</span>
        <a href="/node/123" class="new-action-class">View job</a>
      </div>
    `;

    expect(parseListingPage(html)).toEqual([
      {
        title,
        detailUrl: 'https://e-lavoro.ch/node/123',
        percentage: '',
        dateStr: '',
      },
    ]);
  });

  it('keeps the leaf title when an unmarked card is inside a page with a heading', () => {
    const html = `
      <main>
        <h1>Offerte di lavoro</h1>
        <div class="listing-wrapper">
          <div class="job-card">
            <span>Senior Scientist</span>
            <a href="/node/123" class="new-action-class">View job</a>
          </div>
        </div>
      </main>
    `;

    expect(parseListingPage(html)).toEqual([
      {
        title: 'Senior Scientist',
        detailUrl: 'https://e-lavoro.ch/node/123',
        percentage: '',
        dateStr: '',
      },
    ]);
  });

  it('keeps every detail link when only some cards have an action marker', () => {
    const html = `
      <div class="listing-wrapper">
        <div class="job-card">
          <span class="job-title-row">First role</span>
          <a href="/node/123" class="main-list-job-button-view">View job</a>
        </div>
        <div class="job-card">
          <span class="renamed-title-class">Second role</span>
          <a href="/node/456" class="new-action-class">View job</a>
        </div>
      </div>
    `;

    expect(parseListingPage(html).map(({ detailUrl, title }) => ({ detailUrl, title }))).toEqual([
      { detailUrl: 'https://e-lavoro.ch/node/123', title: 'First role' },
      { detailUrl: 'https://e-lavoro.ch/node/456', title: 'Second role' },
    ]);
  });

  it('records a listing transport failure instead of an unexplained empty source', () => {
    expect(classifyHasHealthcareDiscovery({ listingFetchOutcome: 'connection_error' })).toEqual({
      lastFetchOutcome: 'connection_error',
      abortKind: 'connection-level-fetch',
    });
  });

  it('records a repeated detail transport failure when every discovered detail fails', () => {
    expect(classifyHasHealthcareDiscovery({
      discovered: 2,
      parsed: 0,
      detailFetchOutcomes: ['exhausted_retry', 'exhausted_retry'],
    })).toEqual({
      lastFetchOutcome: 'exhausted_retry',
      abortKind: 'connection-level-fetch',
    });
  });

  it('aborts a partial detail run before stale HAS rows can be pruned', () => {
    expect(classifyHasHealthcareDiscovery({
      discovered: 2,
      parsed: 1,
      detailFetchOutcomes: ['connection_error'],
    })).toEqual({
      lastFetchOutcome: 'connection_error',
      abortKind: 'connection-level-fetch',
    });
  });

  it('keeps parser misses distinct from transport failures', () => {
    expect(classifyHasHealthcareDiscovery({ discovered: 1, parsed: 0 })).toEqual({
      lastFetchOutcome: 'selector_miss',
      abortKind: 'no-jobs-parsed',
    });
  });

  it('marks a run with publishable jobs as successful', () => {
    expect(classifyHasHealthcareDiscovery({ discovered: 1, parsed: 1 })).toEqual({
      lastFetchOutcome: 'ok',
      abortKind: null,
    });
  });
});
