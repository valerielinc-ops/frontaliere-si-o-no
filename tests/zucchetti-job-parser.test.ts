import { describe, expect, it } from 'vitest';
import {
  parseZucchettiListings,
  isZucchettiTargetLocation,
  parseZucchettiJobDetail,
} from '../scripts/lib/zucchetti-job-parser.mjs';

const LISTING_HTML = `
  <div>
    <a class="item-job-list" href="https://zinrec.intervieweb.it/app.php?opmode=guest&module=iframeAnnunci&act1=1&IdAnnuncio=108010">
      <div class="name-job">Software Developer (m/f/d)</div>
      <div class="description-job">We’re seeking a talented Software Developer to join our team.</div>
      <div class="info-job"><span>Mendrisio, Switzerland</span></div>
      <div class="info-job"><span>IT</span></div>
    </a>
    <a class="item-job-list" href="https://zinrec.intervieweb.it/app.php?opmode=guest&module=iframeAnnunci&act1=1&IdAnnuncio=112559">
      <div class="name-job">Support Specialist</div>
      <div class="description-job">Support role in German-speaking Switzerland.</div>
      <div class="info-job"><span>Maerstetten, Switzerland</span></div>
      <div class="info-job"><span>IT</span></div>
    </a>
  </div>
`;

const DETAIL_HTML = `
  <div class="card-body" id="description__header">
    <h2 id="description__vacancy-title">Software Developer (m/f/d)</h2>
    <div id="description__subtitle">
      <span class="subtitle__informations">Mendrisio, Switzerland</span>
      <span class="subtitle__informations">IT</span>
    </div>
    <textarea class="share__hidden">https://zinrec.intervieweb.it/zucchettidach/jobs/software-developer-mfd-108010/de/</textarea>
  </div>
  <div class="card-body vacancy__sections collapse show" id="description__info">
    <div id="description__body">
      <h3 class="body__headings">Firmenbeschreibung</h3>
      <div class="body__text"><p>Zucchetti ist eines der größten IT-Unternehmen Europas.</p></div>
      <h3 class="body__headings">Stellenbeschreibung</h3>
      <div class="body__text"><p>We’re seeking a talented <strong>Software Developer</strong>.</p><ul><li>.NET 8</li><li>C#</li></ul></div>
      <h3 class="body__headings">Anforderungsprofil</h3>
      <div class="body__text"><ul><li>3 years of experience</li></ul></div>
      <h3 class="body__headings">Sonstige Informationen</h3>
      <div class="body__text"><p>Hybrid work environment.</p></div>
    </div>
  </div>
`;

describe('parseZucchettiListings', () => {
  it('extracts listings and target location detection works', () => {
    const rows = parseZucchettiListings(LISTING_HTML);
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('Software Developer (m/f/d)');
    expect(isZucchettiTargetLocation(rows[0].location)).toBe(true);
    expect(isZucchettiTargetLocation(rows[1].location)).toBe(false);
  });
});

describe('parseZucchettiJobDetail', () => {
  it('extracts title, location, share URL and structured markdown-like sections', () => {
    const detail = parseZucchettiJobDetail(DETAIL_HTML);
    expect(detail.title).toBe('Software Developer (m/f/d)');
    expect(detail.location).toBe('Mendrisio, Switzerland');
    expect(detail.category).toBe('IT');
    expect(detail.shareUrl).toContain('/zucchettidach/jobs/software-developer-mfd-108010/de/');
    expect(detail.description).toContain('## Firmenbeschreibung');
    expect(detail.description).toContain('## Stellenbeschreibung');
    expect(detail.description).toContain('- .NET 8');
  });
});
