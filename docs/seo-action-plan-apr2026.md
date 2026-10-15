# SEO Action Plan — April 2026

## Striking Distance Queries (Position 8-15, High Potential)

| Query | Position | Impressions | Page | Action |
|-------|----------|-------------|------|--------|
| switzerland transit fee 2026 | 8.1 | 157 | /en/cross-border-articles/transit-fee-switzerland-2023/ | Update title to include "2026", refresh content |
| traffico dogana chiasso brogeda | 9.0 | 89 | /guida-frontaliere/tempi-attesa-dogana/chiasso-centro/ | Add more content, structured data |
| aktueller dieselpreis schweiz märz 2026 | 8.1 | 55 | /de/grenzgaenger-artikel/diesel-preiserhohung-schweiz-2026/ | Already well-targeted, add FAQ schema |
| compte bancaire pour frontaliers suisse | 8.9 | 38 | /fr/articles-frontalier/ouvrir-compte-bancaire-frontaliers/ | Expand with comparison table |
| costo vita svizzera vs italia | 9.0 | 21 | /compara-servizi/costo-della-vita/ | Add FAQ schema, expand intro |
| calcolo tasse frontalieri oltre 20 km | 8.1 | 18 | /calcola-stipendio/nuovi-frontalieri-oltre-20-km/ | Good match, add examples |
| mutuo svizzera per casa italia | 10.7 | 9 | /articoli-frontaliere/mutuo-casa-frontalieri-italia/ | Add bank comparison, FAQ |

## Low CTR Issues (High Impressions, Below Benchmark)

**Root cause**: Individual job pages rank for broad queries ("offerte di lavoro ticino", "lavoro ticino"). Users expect a job board, get a single listing.

**Fix**: Strengthen main job board landing page `/cerca-lavoro-ticino/offerte-di-lavoro-ticino-oggi/`:
- Add more internal links from job pages back to the board
- Improve title tag: "Offerte di Lavoro Ticino Oggi — 500+ Posizioni | Frontaliere Ticino"
- Add aggregate JobPosting count in meta description
- Consider adding `ItemList` schema for the board page

| Query | Top-ranking page | Pos | CTR | Benchmark |
|-------|-----------------|-----|-----|-----------|
| case anziani ticino offerte di lavoro | concorso-generale-2026-oscam | 1.6 | 7.9% | 15% |
| posti vacanti ticino | concorso-generale-2026-oscam | 2.4 | 4.6% | 15% |
| offerte di lavoro ticino | azienda-unione-farmaceutica | 1.6 | 4.8% | 15% |
| lavoro ticino | azienda-unione-farmaceutica | 1.5 | 5.9% | 30% |

## Programmatic Job Ad Backfill — Feasibility

**Constraint**: GitHub Pages (static site, no SSR, client-side JS only).

### Viable Options

1. **Talent.com Publisher Program** — JS widget showing sponsored job listings on job pages. CPC revenue model. Requires approval + minimum traffic threshold (~50k monthly visits). Widget is client-side JS. Best fit for this site.

2. **Jooble Publisher Feed** — Similar JS widget, lower traffic threshold. CPC-based. Targets Italian/Swiss job market.

3. **Google AdSense for Search** — Custom search ads on the job board. Easy integration (JS snippet), but low relevance for niche frontalieri content.

4. **Appcast** — Primarily a programmatic job advertising platform for employers. Publisher side requires server-side XML feed delivery and click tracking. Not compatible with static hosting without a proxy.

### Recommendation

**Start with Talent.com Publisher Program.** It's the most natural fit:
- Job-relevant ads (not display garbage)
- Client-side JS widget (works on GitHub Pages)
- CPC model aligned with user intent
- Respects the existing UX (contextual job suggestions, not banners)

**Next step**: Apply at talent.com/publisher with traffic stats from GA4. Need ~50k monthly pageviews on job pages (check GA4 for current numbers).

**Not recommended**: Display ads (AdSense, Media.net) — too low-quality for the brand, will hurt trust with the core audience of decision-making frontalieri.

## Generated
- Date: 2026-04-12
- Source: Google Search Console API (28-day window)
