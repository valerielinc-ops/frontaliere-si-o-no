# CreatorProducts Redesign + Image Fix

**Date:** 2026-03-25
**Component:** `components/pages/CreatorProducts.tsx`
**Script:** `scripts/fetch-amazon-products.mjs`
**Service:** `services/creatorProductsService.ts`

## Problem

1. `amazon-products.json` è in modalità fallback (`api_error`) — le immagini usano URL CDN statici che restituiscono GIF 1×1 trasparenti
2. Il componente rileva la GIF e mostra l'emoji invece dell'immagine del prodotto
3. Il layout attuale (36×36px thumbnail, 11px font) è troppo compatto e poco leggibile

## Solution

### Part 1 — Fix image URLs

**In `scripts/fetch-amazon-products.mjs`**, funzione `buildStaticProducts()`:
Sostituire il pattern CDN statico con l'Amazon Associates image widget:
```
https://ws-eu.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN={asin}&Format=_SL250_&ID=AsinImage&MarketPlace=IT&ServiceVersion=20070822&WS=1&tag=luigi066-21
```
Nota: usare `_SL250_` (non `_SL160_`) per assicurare nitidezza su display Retina (2x) con immagini 72px.
Questi URL restituiscono immagini reali (via 302 redirect) senza credenziali API, usando solo l'affiliate tag.

**In `services/creatorProductsService.ts`**, funzione `buildAmazonImageUrl()`:
Aggiornare lo stesso URL pattern. Questa funzione è il fallback quando `apiData?.imageUrl` è assente — deve usare il nuovo formato per evitare URL rotti nel codepath di fallback.

**Fallback detection in `CreatorProducts.tsx`**: la logica `handleImgLoad` / `handleImgError` (rilevamento GIF 1×1 con `naturalWidth < 5`) **rimane invariata** come rete di sicurezza per ASIN discontinuati o errori del widget. Se anche il widget fallisce, il componente cade sull'emoji — comportamento corretto.

### Part 2 — Redesign card layout

**Card per prodotto:**
- Immagine: `width={72} height={72}` (HTML attributes), `object-contain`, `bg-white`, `rounded-lg`, `shadow-sm`
- Titolo: `text-[13px] font-semibold leading-snug line-clamp-2`
- Prezzo: `text-[11px] font-bold text-emerald-600 dark:text-emerald-400`
- Hover: `hover:border-indigo-300 dark:hover:border-indigo-700` + `hover:scale-[1.01] transition-all`
- ExternalLink icona: `size={12}` in alto a destra
- Emoji fallback: `text-2xl` (era `text-lg`) per proporzionalità con immagine 72px

**Container:**
- `space-y-2.5` (era `space-y-2`)
- `overflow-visible` sul container esterno per evitare clipping del `scale` hover
- Disclosure: `text-[10px] text-slate-500 dark:text-slate-400` (era `text-[9px] text-slate-500 dark:text-slate-600`)

## Files Changed

1. `scripts/fetch-amazon-products.mjs` — fix URL immagine in `buildStaticProducts()` con `_SL250_`
2. `services/creatorProductsService.ts` — fix `buildAmazonImageUrl()` con stesso pattern
3. `components/pages/CreatorProducts.tsx` — redesign layout card + attributi `width/height` a 72
4. `data/amazon-products.json` — rigenerare con nuovi URL (via script, oppure fix manuale per test immediato)

## Non-Goals

- Non fix dell'API Amazon Creators (separato)
- Non cambio a `maxCards` (resta 2)
- Non cambio alla logica di matching keyword
- Non aggiunta di test (componente UI esistente, nessuna logica nuova)
