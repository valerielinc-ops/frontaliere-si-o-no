/**
 * Trimmed-but-representative snapshot of the arbeit.swiss / SECO home page
 * (https://www.arbeit.swiss/secoalv/it/home.html) as served on 2026-06-10.
 *
 * The live page is a Nuxt single-page app (~600 KB). This fixture keeps only the
 * structures the extractor depends on, so the parser is locked against the
 * CURRENT markup:
 *   - the rendered labour-market teaser card (heading + description span) whose
 *     description carries the rate sentence "…tasso di disoccupazione … al N,N%";
 *   - the embedded-JSON copy of that sentence, immediately followed by the
 *     canonical admin.ch press-release URL;
 *   - a DISTRACTOR heading ("Portale lavoro.swiss – nuova veste da giugno 2026")
 *     with a different, later month — present to prove the parser binds the
 *     period to the SAME sentence as the rate and does NOT pick the distractor.
 *
 * No absolute/relative dates are computed from "now"; the captured period
 * (maggio 2026 → 2026-05) is a literal of the snapshot itself, which is the
 * point of a drift-locking fixture.
 */
export const SECO_UNEMPLOYMENT_HOME_HTML = `
<!doctype html><html lang="it"><head><title>SECO</title></head><body>
<div id="__nuxt">
  <section class="hero">
    <div class="hero-section__content"><!--[--><!--[-->
      <h2 class="u-heading"><span>Portale lavoro.swiss &#8211; nuova veste da giugno 2026</span></h2>
      <p>Scoprite il nuovo portale a partire da giugno 2026.</p>
    </div>
  </section>

  <div class="u-base-card u-teaser-card u-teaser-card--list"><!--[--><!--]-->
    <div class="u-base-card__content"><!--[--><!--]-->
      <div class="u-base-card__body">
        <div class="u-base-card__body__text"><!--[--><!--]-->
          <h5 class="u-heading"><span>La situazione sul mercato del lavoro nel mese di maggio 2026</span></h5>
          <span class="u-teaser-card__description">Nel mese di maggio 2026 il numero dei disoccupati &#232; diminuito di 2&#8217;627 unit&#224; (-1,8%) rispetto al mese precedente, per un totale di 140&#8217;275 persone. Rispetto allo stesso mese dell&#8217;anno precedente, il numero dei disoccupati &#232; aumentato di 12&#8217;331 unit&#224; (+9,6%). Nel mese di maggio 2026 il tasso di disoccupazione &#232; rimasto invariato al 3,0%.</span><!--]-->
        </div>
        <!--[--><Button to class="u-work-swiss-button u-teaser-card__button--list" tabindex="-1" aria-hidden="true"><!--[--><!--]--><!--[--><span>Di pi&#249;</span></Button>
      </div>
    </div>
  </div>
</div>

<script>window.__NUXT__=(function(){return {data:[{"title":"La situazione sul mercato del lavoro nel mese di maggio 2026","lead":"Nel mese di maggio 2026 il numero dei disoccupati è diminuito di 2’627 unità (-1,8%) rispetto al mese precedente, per un totale di 140’275 persone. Rispetto allo stesso mese dell’anno precedente, il numero dei disoccupati è aumentato di 12’331 unità (+9,6%). Nel mese di maggio 2026 il tasso di disoccupazione è rimasto invariato al 3,0%.","https://www.admin.ch/it/newnsb/GJB5uJRiX3qu8TRWGlPLr",{"component":7424}]}}})()</script>
</body></html>
`;

/** Expected extraction from the fixture above. */
export const SECO_UNEMPLOYMENT_EXPECTED = {
  rate: 3,
  period: '2026-05',
  href: 'https://www.admin.ch/it/newnsb/GJB5uJRiX3qu8TRWGlPLr',
};
