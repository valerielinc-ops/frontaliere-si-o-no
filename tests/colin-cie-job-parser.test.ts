import { describe, expect, it } from 'vitest';
import { parseColinCieJobDescription } from '../scripts/lib/colin-cie-job-parser.mjs';

// colin-cie.com/de/karriere/wm-berater-de-luxemburg-07-2024 on 2026-09-29,
// minimized. The office paragraph is what tells the Luxembourg posting from
// the Zürich one; the contact card (name, phone) follows and stays out.
const detail = (office: string, officeText: string) => `<div id='cblock_1451' class='contentBlock h4'>
<h4><strong><span class="mediumStyle">Sind Sie als Vermögensberater (m/w/d) auf der Suche nach einer Möglichkeit, Ihre Kunden unabhängiger zu beraten?<br><br></span></strong></h4></div>
<div id='cblock_1452' class='contentBlock'>
<h3 class="text-137"><span class="pinkStyle">Das bieten wir Ihnen</span></h3>
<ul class="simpleList text-112">
<li>Eine zukunftsorientierte Vision und eine erfolgreiche Geschäftsstrategie</li>
</ul></div>
<div id='cblock_1454' class='contentBlock'>
<h3 class="text-137"><span class="pinkStyle">Das bringen Sie mit</span></h3>
<ul class="simpleList text-112">
<li>Ein bestehendes Business-/ Kundennetzwerk in Deutschland</li>
</ul></div>
<div id='cblock_1455' class='contentBlock contentBlock-inforight'>
<h4><span class="pinkStyle">Die Colin&amp;Cie-Gruppe</span></h4>
<p>Colin&amp;Cie gehört zu den führenden bankenunabhängigen Vermögensverwaltern in der Schweiz und Luxemburg.</p>
<p></p></div>
<div id='cblock_1456' class='contentBlock contentBlock-inforight'>
<h4><span class="pinkStyle">Colin&amp;Cie in ${office}</span></h4>
<p>${officeText}</p>
<p></p></div>
<div id='cblock_1457' class='contentBlock contentBlock-inforight'>
<h4><span class="pinkStyle">Haben wir Ihr Interesse geweckt?</span></h4>
<p>Dann nehmen Sie Kontakt zu uns auf. </p></div>
<div id='cblock_1458' class='contentBlock text-Image-left'>
<div class='width-50 contentBox_textWrapper'>
<span class="boxTeaser">IhrE AnsprechpartnerIN</span>
<p class="text-162">Vorname Nachname</p>
<p class="text-137">T <a href="tel:+41000000000">+41 00 000 00 00</a></p>
</div></div>`;

describe('Colin&Cie detail description', () => {
  it('keeps the office, group and closing paragraphs after the three lists', () => {
    const luxembourg = parseColinCieJobDescription(detail('Luxemburg', 'Die Colin&amp;Cie Luxembourg S.A. wurde im Jahre 2011 gegründet. Sitz der Gesellschaft ist Munsbach.'));
    const zurich = parseColinCieJobDescription(detail('Zürich', 'Colin&amp;Cie in Zürich liegt zentral zwischen Hauptbahnhof und Seeufer.'));

    expect(luxembourg).toMatch(/^Sind Sie als Vermögensberater/);
    expect(luxembourg).toContain('## Das bieten wir Ihnen\n• Eine zukunftsorientierte Vision');
    expect(luxembourg).toContain('## Die Colin&Cie-Gruppe\nColin&Cie gehört zu den führenden');
    expect(luxembourg).toContain('## Colin&Cie in Luxemburg\nDie Colin&Cie Luxembourg S.A. wurde im Jahre 2011 gegründet.');
    expect(luxembourg).toContain('## Haben wir Ihr Interesse geweckt?\nDann nehmen Sie Kontakt zu uns auf.');
    expect(luxembourg).not.toContain('Vorname Nachname');
    expect(luxembourg).not.toContain('+41 00');
    expect(zurich).toContain('Colin&Cie in Zürich liegt zentral');
    expect(zurich).not.toBe(luxembourg);
  });
});
