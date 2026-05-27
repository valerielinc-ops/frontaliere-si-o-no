import { describe, it, expect } from 'vitest';
import {
  htmlToMarkdown,
  decodeEntities,
  validateAxpoDescription,
} from '../scripts/lib/axpo-job-parser.mjs';

// ──────────────────────────────────────────────────────────────
// Real RSS fixture: Anlagenführer/in Holzheizkraftwerk
// Uses · (middle-dot) pseudo-bullets in <p> tags
// ──────────────────────────────────────────────────────────────

const FIXTURE_ANLAGENFUEHRER_ENTITY = `&lt;h4&gt;&lt;span&gt;&lt;strong&gt;Pensum: 100% | Domat - Ems&lt;/strong&gt;&lt;/span&gt;&lt;/h4&gt;&lt;p&gt;&lt;span&gt;&lt;strong&gt;Einen Beitrag zur Energiezukunft leisten.&lt;/strong&gt; Du bist auf der Suche nach einer spannenden und verantwortungsvollen Aufgabe in der Energiebranche? Dann haben wir genau das Richtige für Dich! Als Heizwerkführer bist Du das Herzstück unserer Kraftwerksanlagen und sorgst für einen sicheren und wirtschaftlichen Betrieb.&lt;/span&gt;&lt;/p&gt;&lt;h3&gt;&lt;span&gt;&lt;strong&gt;Aufgaben &amp;amp; Verantwortlichkeiten:&lt;/strong&gt;&lt;/span&gt;&lt;/h3&gt;&lt;p&gt;&lt;span&gt;·&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp; &lt;strong&gt;Überwachen und Bedienen&lt;/strong&gt; der Kraftwerksanlagen, um eine hohe Verfügbarkeit sicherzustellen&lt;/span&gt;&lt;/p&gt;&lt;p&gt;&lt;span&gt;·&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp; &lt;strong&gt;Kontrollgänge und Dokumentation&lt;/strong&gt;: Du überprüfst die Anlagen regelmässig und hältst Deine Beobachtungen im Schichtbuch fest&lt;/span&gt;&lt;/p&gt;&lt;p&gt;&lt;span&gt;·&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp; &lt;strong&gt;Störungsbehebung&lt;/strong&gt; und kleine Wartungsarbeiten: Du packst an, wenn etwas nicht rund läuft&lt;/span&gt;&lt;/p&gt;&lt;p&gt;&lt;span&gt;·&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp; &lt;strong&gt;Reinigungsarbeiten&lt;/strong&gt; an den Anlagen, um einen reibungslosen Betrieb zu garantieren&lt;/span&gt;&lt;/p&gt;&lt;p&gt;&lt;span&gt;·&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp; &lt;strong&gt;Kommunikation und Reporting&lt;/strong&gt;: Probleme und notwendige Reparaturen meldest Du direkt Deinem Vorgesetzten&lt;/span&gt;&lt;/p&gt;&lt;h3&gt;&lt;span&gt;&lt;strong&gt;Profil &amp;amp; Anforderungen:&lt;/strong&gt;&lt;/span&gt;&lt;/h3&gt;&lt;p&gt;&lt;span&gt;·&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp; &lt;strong&gt;Technisches Know-how&lt;/strong&gt;: Eine abgeschlossene Lehre in einem handwerklichen Beruf mit Berufserfahrung (vorzugsweise Bereich Mechanik, Elektrotechnik oder Anlagenführer)&lt;/span&gt;&lt;/p&gt;&lt;p&gt;&lt;span&gt;·&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp; &lt;strong&gt;Flexibilität&lt;/strong&gt;: Du bist bereit, im 24/7-Schichtbetrieb zu arbeiten&lt;/span&gt;&lt;/p&gt;&lt;p&gt;&lt;span&gt;·&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp; &lt;strong&gt;Fachliche Kompetenz&lt;/strong&gt;: Kenntnisse in Mess-, Steuer- und Regeltechnik sind von Vorteil&lt;/span&gt;&lt;/p&gt;&lt;p&gt;&lt;span&gt;·&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp; &lt;strong&gt;Bereitschaft&lt;/strong&gt;: Du wohnst im Nahbereich des Kraftwerks und bist offen für Weiterbildung im Bereich Heizwerk&lt;/span&gt;&lt;/p&gt;&lt;h3&gt;&lt;span&gt;&lt;strong&gt;Über das Team:&lt;/strong&gt;&lt;/span&gt;&lt;/h3&gt;&lt;p&gt;&lt;span&gt;Du arbeitest in einem engagierten 3er-Team unter der Leitung des Betriebsleiters. Zusammen sorgt ihr für den optimalen Betrieb des Holzheizkraftwerks – von der Überwachung bis zur Wartung.&lt;/span&gt;&lt;/p&gt;&lt;hr&gt;&lt;p&gt;&lt;em&gt;&lt;span&gt;Axpo ist stolz darauf, ein Arbeitsumfeld zu bieten, das Vielfalt, Inklusion und Chancengleichheit fördert. Wir schätzen die Einzigartigkeit jedes Einzelnen und begrüssen Bewerbungen unabhängig von ethnischer Herkunft, Geschlechtsidentität und -ausdruck, sexueller Orientierung, Alter, Behinderung sowie sozioökonomischem, kulturellem und religiösem Hintergrund. Wir verpflichten uns zu einem respektvollen und inklusiven Rekrutierungsprozess sowie einem diskriminierungsfreien Arbeitsumfeld für alle.&lt;/span&gt;&lt;/em&gt;&lt;/p&gt;`;

// ──────────────────────────────────────────────────────────────
// Real RSS fixture: Dispatcher/in Betriebs- und Schichtdienst
// Uses proper <ul>/<li> lists including nested lists
// ──────────────────────────────────────────────────────────────

const FIXTURE_DISPATCHER_ENTITY = `&lt;h4&gt;&lt;span&gt;&lt;strong&gt;Pensum: 80% oder mehr | Axpo Hydro Surselva AG | Tavanasa&lt;/strong&gt;&lt;/span&gt;&lt;/h4&gt;&lt;p&gt;&lt;span&gt;&lt;strong&gt;Arbeiten in einer der spannendsten Branchen der Schweiz – nachhaltige Energie!&lt;/strong&gt; Als Dispatcher im Betriebs- und Schichtdienst bei Axpo Hydro Surselva AG sorgst du für den sicheren, ressourcenschonenden und effizienten Betrieb unserer Kraftwerks- und Netzanlagen. In dieser verantwortungsvollen Rolle bist du ein zentraler Bestandteil unseres Teams und überwachst die Anlagen rund um die Uhr von der Kraftwerkssteuerstelle (KSS) aus.&lt;/span&gt;&lt;/p&gt;&lt;h3&gt;&lt;span&gt;&lt;strong&gt;Aufgaben &amp;amp; Verantwortlichkeiten:&lt;/strong&gt;&lt;/span&gt;&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;Betrieb und Überwachung unserer Kraftwerks- und Netzanlagen im Schichtdienst (24/7)&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;Erfassung und Weiterleitung von Störmeldungen sowie Organisation des Pikettmitarbeiters&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;Umsetzung und Erstellung von Energiefahrplänen&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;Erstellung von Wasserhaushaltsprognosen für den Flex Pool&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;Plausibilisierung und Überwachung der Energiefahrpläne des Flex Pools&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;Systematische Durchführung wöchentlicher Vor-Ort-Kontrollen in den Kraftwerksanlagen&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;/ul&gt;&lt;h3&gt;&lt;span&gt;&amp;nbsp;&lt;strong&gt;Profil &amp;amp; Anforderungen:&lt;/strong&gt;&amp;nbsp;&lt;/span&gt;&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;&lt;strong&gt;Ausbildung:&lt;/strong&gt; Abgeschlossene technische Ausbildung (z. B. Automatiker EFZ, Elektroinstallateur EFZ, Netzelektriker, Polymechaniker EFZ oder vergleichbare Qualifikation)&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;&lt;strong&gt;Erfahrung:&lt;/strong&gt; Betrieb und Instandhaltung von Wasserkraftwerken von Vorteil&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;&lt;strong&gt;Fähigkeiten:&lt;/strong&gt;&lt;/span&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;Sehr gute systemtechnische Kenntnisse&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;Umgang mit MS-Office und digitalen Arbeitsmitteln&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;Vernetztes Denken und rasche Auffassungsgabe&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;Selbständige, entscheidungsfreudige und zuverlässige Arbeitsweise&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;/ul&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;&lt;strong&gt;Sprache:&lt;/strong&gt; Gute Deutschkenntnisse in Wort und Schrift, Romanisch- und/oder Italienischkenntnisse von Vorteil&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;&lt;strong&gt;Flexibilität:&lt;/strong&gt; Du bist bereit, im 24/7-Schichtbetrieb zu arbeiten und an Samstagen, Sonntagen sowie Feiertagen (inkl. Pikett) im Einsatz zu sein&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;&lt;span&gt;&lt;strong&gt;Wohnort:&lt;/strong&gt; Idealerweise wohnhaft im Einzugsgebiet der Surselva&lt;/span&gt;&lt;/p&gt;&lt;/li&gt;&lt;/ul&gt;&lt;h3&gt;&lt;span&gt;&lt;strong&gt;Über das Team:&lt;/strong&gt;&lt;/span&gt;&lt;/h3&gt;&lt;p&gt;&lt;span&gt;Du wirst Teil eines erfahrenen Teams aus Kraftwerksbetrieb, Instandhaltung und Engineering, das gemeinsam die Wasserkraftanlagen in der Region Surselva betreibt.&lt;/span&gt;&lt;/p&gt;&lt;hr&gt;&lt;p&gt;&lt;em&gt;&lt;span&gt;Axpo ist stolz darauf, ein Arbeitsumfeld zu bieten, das Vielfalt, Inklusion und Chancengleichheit fördert. Wir schätzen die Einzigartigkeit jedes Einzelnen und begrüssen Bewerbungen unabhängig von ethnischer Herkunft, Geschlechtsidentität und -ausdruck, sexueller Orientierung, Alter, Behinderung sowie sozioökonomischem, kulturellem und religiösem Hintergrund. Wir verpflichten uns zu einem respektvollen und inklusiven Rekrutierungsprozess sowie einem diskriminierungsfreien Arbeitsumfeld für alle.&lt;/span&gt;&lt;/em&gt;&lt;/p&gt;`;

// Already-decoded HTML (not entity-encoded)
const FIXTURE_ANLAGENFUEHRER_HTML = `<h4><span><strong>Pensum: 100% | Domat - Ems</strong></span></h4><p><span><strong>Einen Beitrag zur Energiezukunft leisten.</strong> Du bist auf der Suche nach einer spannenden Aufgabe?</span></p><h3><span><strong>Aufgaben & Verantwortlichkeiten:</strong></span></h3><p><span>·\u00a0\u00a0\u00a0\u00a0 <strong>Überwachen</strong> der Kraftwerksanlagen</span></p><p><span>·\u00a0\u00a0\u00a0\u00a0 <strong>Kontrollgänge</strong>: Du überprüfst regelmässig</span></p><h3><span><strong>Profil & Anforderungen:</strong></span></h3><p><span>·\u00a0\u00a0\u00a0\u00a0 <strong>Technisches Know-how</strong>: Abgeschlossene Lehre</span></p>`;

// ──────────────────────────────────────────────────────────────
// decodeEntities tests
// ──────────────────────────────────────────────────────────────

describe('decodeEntities', () => {
  it('decodes all standard HTML entities', () => {
    const input = '&lt;p&gt;Hello &amp; &quot;world&quot; &#39;test&#39;&lt;/p&gt;';
    const result = decodeEntities(input);
    expect(result).toBe('<p>Hello & "world" \'test\'</p>');
  });

  it('decodes &nbsp; to non-breaking space', () => {
    expect(decodeEntities('hello&nbsp;world')).toBe('hello\u00A0world');
  });

  it('handles empty input', () => {
    expect(decodeEntities('')).toBe('');
    expect(decodeEntities(undefined)).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────
// htmlToMarkdown: entity-encoded input
// ──────────────────────────────────────────────────────────────

describe('htmlToMarkdown — entity-encoded RSS content', () => {
  it('converts Anlagenführer entity-encoded HTML to markdown', () => {
    const { markdown, sourceTextLength, headingCount, bulletCount } = htmlToMarkdown(FIXTURE_ANLAGENFUEHRER_ENTITY);

    expect(markdown.length).toBeGreaterThanOrEqual(400);
    expect(sourceTextLength).toBeGreaterThan(0);

    // Should have section headings
    expect(headingCount).toBeGreaterThanOrEqual(3);
    expect(markdown).toContain('## Pensum: 100% | Domat - Ems');
    expect(markdown).toContain('## Aufgaben & Verantwortlichkeiten:');
    expect(markdown).toContain('## Profil & Anforderungen:');
    expect(markdown).toContain('## Über das Team:');

    // Should have bullets converted from · paragraphs
    expect(bulletCount).toBeGreaterThanOrEqual(5);
    expect(markdown).toContain('- **Überwachen und Bedienen**');
    expect(markdown).toContain('- **Kontrollgänge und Dokumentation**');
    expect(markdown).toContain('- **Störungsbehebung**');

    // No raw HTML tags
    expect(markdown).not.toMatch(/<[a-z][a-z0-9]*[\s>]/i);
    expect(markdown).not.toContain('&lt;');
    expect(markdown).not.toContain('&gt;');
    expect(markdown).not.toContain('&amp;');
  });

  it('converts Dispatcher entity-encoded HTML with <ul>/<li> to markdown', () => {
    const { markdown, headingCount, bulletCount } = htmlToMarkdown(FIXTURE_DISPATCHER_ENTITY);

    expect(markdown.length).toBeGreaterThanOrEqual(400);
    expect(headingCount).toBeGreaterThanOrEqual(3);

    // Proper <ul> bullets
    expect(bulletCount).toBeGreaterThanOrEqual(6);
    expect(markdown).toContain('- Betrieb und Überwachung unserer Kraftwerks');
    expect(markdown).toContain('- Umsetzung und Erstellung von Energiefahrplänen');

    // Nested list items
    expect(markdown).toContain('- Sehr gute systemtechnische Kenntnisse');

    // No raw HTML
    expect(markdown).not.toMatch(/<[a-z][a-z0-9]*[\s>]/i);
  });

  it('preserves bold inline text', () => {
    const { markdown } = htmlToMarkdown(FIXTURE_ANLAGENFUEHRER_ENTITY);
    expect(markdown).toContain('**Überwachen und Bedienen**');
    expect(markdown).toContain('**Technisches Know-how**');
  });

  it('preserves italic text', () => {
    const { markdown } = htmlToMarkdown(FIXTURE_ANLAGENFUEHRER_ENTITY);
    expect(markdown).toContain('*Axpo ist stolz darauf');
  });

  it('includes HR separator', () => {
    const { markdown } = htmlToMarkdown(FIXTURE_ANLAGENFUEHRER_ENTITY);
    expect(markdown).toContain('---');
  });
});

// ──────────────────────────────────────────────────────────────
// htmlToMarkdown: already-decoded HTML
// ──────────────────────────────────────────────────────────────

describe('htmlToMarkdown — already-decoded HTML', () => {
  it('handles already-decoded HTML without double-decoding', () => {
    const { markdown, headingCount, bulletCount } = htmlToMarkdown(FIXTURE_ANLAGENFUEHRER_HTML);

    expect(headingCount).toBeGreaterThanOrEqual(3);
    expect(bulletCount).toBeGreaterThanOrEqual(2);
    expect(markdown).toContain('## Pensum: 100% | Domat - Ems');
    expect(markdown).toContain('- **Überwachen**');
    expect(markdown).not.toMatch(/<[a-z][a-z0-9]*[\s>]/i);
  });
});

// ──────────────────────────────────────────────────────────────
// htmlToMarkdown: edge cases
// ──────────────────────────────────────────────────────────────

describe('htmlToMarkdown — edge cases', () => {
  it('handles empty input', () => {
    const result = htmlToMarkdown('');
    expect(result.markdown).toBe('');
    expect(result.sourceTextLength).toBe(0);
    expect(result.headingCount).toBe(0);
    expect(result.bulletCount).toBe(0);
  });

  it('handles plain text without HTML', () => {
    const { markdown } = htmlToMarkdown('Just plain text here');
    expect(markdown).toBe('Just plain text here');
  });

  it('handles <figure> and <lite-youtube> removal', () => {
    const input = '<figure><lite-youtube videoid="abc123"></lite-youtube></figure><p>Real content</p>';
    const { markdown } = htmlToMarkdown(input);
    expect(markdown).not.toContain('abc123');
    expect(markdown).toContain('Real content');
  });

  it('handles deeply nested spans', () => {
    const input = '<p><span><span><span>Deep text</span></span></span></p>';
    const { markdown } = htmlToMarkdown(input);
    expect(markdown).toContain('Deep text');
  });

  it('handles <a> links', () => {
    const input = '<p>Apply at <a href="https://careers.axpo.com">Axpo Careers</a></p>';
    const { markdown } = htmlToMarkdown(input);
    expect(markdown).toContain('[Axpo Careers](https://careers.axpo.com)');
  });

  it('normalizes excessive whitespace', () => {
    const input = '<p>  Hello   world  </p><p>  Next  </p>';
    const { markdown } = htmlToMarkdown(input);
    expect(markdown).not.toMatch(/  /);
  });

  it('converts all-bold paragraph to heading when short', () => {
    const input = '<p><strong>Section Title</strong></p><p>Normal text here.</p>';
    const { markdown, headingCount } = htmlToMarkdown(input);
    expect(headingCount).toBe(1);
    expect(markdown).toContain('## Section Title');
  });

  it('does NOT convert long bold paragraphs to headings', () => {
    const longBold = 'A'.repeat(100);
    const input = `<p><strong>${longBold}</strong></p>`;
    const { markdown, headingCount } = htmlToMarkdown(input);
    expect(headingCount).toBe(0);
    expect(markdown).toContain(`**${longBold}**`);
  });

  it('converts bullet characters (•, ●, ▪) to list items', () => {
    const input = '<p>• Item one</p><p>● Item two</p><p>▪ Item three</p>';
    const { markdown, bulletCount } = htmlToMarkdown(input);
    expect(bulletCount).toBe(3);
    expect(markdown).toContain('- Item one');
    expect(markdown).toContain('- Item two');
    expect(markdown).toContain('- Item three');
  });

  it('handles ordered lists', () => {
    const input = '<ol><li>First</li><li>Second</li><li>Third</li></ol>';
    const { markdown } = htmlToMarkdown(input);
    expect(markdown).toContain('1. First');
    expect(markdown).toContain('2. Second');
    expect(markdown).toContain('3. Third');
  });
});

// ──────────────────────────────────────────────────────────────
// validateAxpoDescription
// ──────────────────────────────────────────────────────────────

describe('validateAxpoDescription', () => {
  it('passes for valid Anlagenführer description', () => {
    const detail = htmlToMarkdown(FIXTURE_ANLAGENFUEHRER_ENTITY);
    const { ok, warnings } = validateAxpoDescription(detail);
    expect(ok).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('passes for valid Dispatcher description', () => {
    const detail = htmlToMarkdown(FIXTURE_DISPATCHER_ENTITY);
    const { ok, warnings } = validateAxpoDescription(detail);
    expect(ok).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('fails for too-short description', () => {
    const detail = { markdown: 'Short', sourceTextLength: 100, headingCount: 0, bulletCount: 0 };
    const { ok, warnings } = validateAxpoDescription(detail);
    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('too short'))).toBe(true);
  });

  it('fails for low source ratio', () => {
    const detail = { markdown: 'A'.repeat(450), sourceTextLength: 5000, headingCount: 1, bulletCount: 0 };
    const { ok, warnings } = validateAxpoDescription(detail);
    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('ratio too low'))).toBe(true);
  });

  it('warns when no headings on long source', () => {
    const detail = { markdown: 'A'.repeat(600), sourceTextLength: 600, headingCount: 0, bulletCount: 0 };
    const { ok, warnings } = validateAxpoDescription(detail);
    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('No section headings'))).toBe(true);
  });

  it('accepts short source without heading requirement', () => {
    const detail = { markdown: 'A'.repeat(450), sourceTextLength: 450, headingCount: 0, bulletCount: 0 };
    const { ok, warnings } = validateAxpoDescription(detail);
    expect(ok).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('uses custom min thresholds', () => {
    const detail = { markdown: 'A'.repeat(300), sourceTextLength: 300, headingCount: 0, bulletCount: 0 };
    const { ok } = validateAxpoDescription(detail, 200, 0.1);
    expect(ok).toBe(true);
  });
});
