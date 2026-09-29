import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseSohDetail, sohBenefits, sohJobFacts } from '../scripts/lib/soh-solothurner-spitaeler-job-parser.mjs';

// Real jobs.so-h.ch vacancy page (2026-09-29, "Dipl. Pflegefachfrau /
// Pflegefachmann Chirurgie sowie Frauenklinik Wöchnerinnenabteilung"),
// minimized to the JobPosting JSON-LD, the job-info facts, the tasks/profile
// blocks, the benefits carousel and the contact section. Images dropped,
// contact person anonymized.
const DETAIL_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'soh-solothurner-spitaeler', 'detail-pflege-chirurgie.html'),
  'utf8',
);

describe('soh-solothurner-spitaeler detail', () => {
  it('prints each task and profile item once, not once from description and again from responsibilities/qualifications', () => {
    const { descriptionText } = parseSohDetail(DETAIL_HTML)!;
    expect(descriptionText.match(/Engagement bei Weiterentwicklung des Pflegeprozesses/g)).toHaveLength(1);
    expect(descriptionText.match(/Teamfähige, empathische und belastbare Persönlichkeit/g)).toHaveLength(1);
    expect(descriptionText).toMatch(/\nDas bewegen Sie bei uns\n• Verantwortung für die fachkompetente/);
    expect(descriptionText).toMatch(/\nDas bringen Sie mit\n• Dipl\. Pflegefachfrau oder Pflegefachmann HF\/FH/);
  });

  it('opens with the start date, workload, site and ward the page states above the posting', () => {
    expect(sohJobFacts(DETAIL_HTML).split('\n')).toEqual([
      'Eintritt: per sofort oder nach Vereinbarung',
      'Pensum: 70 - 100 %',
      'Standort: Bürgerspital Solothurn, Schöngrünstrasse 42, 4500 Solothurn',
      'Abteilung: Interdisziplinäre Chirurgie sowie Frauenklinik inkl. Wöchnerinnenabteilung',
    ]);
    expect(parseSohDetail(DETAIL_HTML)!.descriptionText.startsWith('Eintritt: per sofort oder nach Vereinbarung\nPensum: 70 - 100 %')).toBe(true);
  });

  it('adds the offer from the benefits carousel once per card, before the contact block', () => {
    const benefits = sohBenefits(DETAIL_HTML);
    const lines = benefits.split('\n');
    expect(lines[0]).toBe('Für uns selbstverständlich');
    expect(lines).toContain('• Arbeiten in Teilzeit: Fast alle unsere Stellen sind im Teilzeitpensum möglich.');
    expect(lines).toContain('• Attraktive Löhne: 13 Gehälter, Leistungsbonus & jährliche Lohnerhöhung bis Erfahrungsstufe 20.');
    expect(new Set(lines).size).toBe(lines.length);
    const { descriptionText } = parseSohDetail(DETAIL_HTML)!;
    expect(descriptionText.indexOf('Für uns selbstverständlich')).toBeGreaterThan(descriptionText.indexOf('Das bringen Sie mit'));
    expect(descriptionText.indexOf('Für uns selbstverständlich')).toBeLessThan(descriptionText.indexOf('Bei Fragen zur Stelle'));
  });

  it('resolves the ATS custom-field placeholder in the contact line from the page', () => {
    const { descriptionText } = parseSohDetail(DETAIL_HTML)!;
    expect(descriptionText).toContain('Bei Fragen zur Stelle (Referenz 986):');
    expect(descriptionText).not.toMatch(/%kundenfeld-\d+%/);
  });
});
