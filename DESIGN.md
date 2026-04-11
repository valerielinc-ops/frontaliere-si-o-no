# Frontaliere Ticino Design System

> **Stripe-inspired**: Sophisticated authority meets financial precision.
> "Precise. Authoritative. Trustworthy." — Technical sophistication meets approachable clarity.

## 1. Visual Theme & Atmosphere

Frontaliere Ticino is a financial decision-making tool for cross-border workers ("frontalieri") navigating the Swiss-Italian border. The design draws from **Stripe's** visual language: clean, authoritative, and technically sophisticated without being cold.

The visual language operates on a **clean white canvas** with high-contrast text and a signature **electric purple** accent (`#533afd`). This immediately communicates fintech credibility and modernity. The purple stands apart from the green/blue fintech crowd while signaling innovation and trust.

**Key aesthetic properties:**
- Conservative border-radius (`6px`) — sharp, professional, not playful
- Blue-tinted shadows (`rgba(50,50,93,*)`) — adds depth without heaviness
- Ultra-light display headings (weight 300) — elegant, not aggressive
- High information density with generous whitespace between sections

## 2. Color System

### Light Mode (`:root`)

| Token | Value | Usage |
|-------|-------|-------|
| `--_surface` | `#ffffff` | Primary background |
| `--_surface-alt` | `#f8fafc` | Alternate/grouped sections |
| `--_surface-raised` | `#f1f5f9` | Elevated surfaces |
| `--_heading` | `#0f172a` | Headlines — near-black |
| `--_body` | `#334155` | Body text |
| `--_subtle` | `#475569` | Secondary text |
| `--_muted` | `#64748b` | Helper/meta text |
| `--_edge` | `#e2e8f0` | Borders, dividers |
| `--_accent` | `#533afd` | Primary accent — Stripe purple |
| `--_accent-hover` | `#4529e6` | Accent hover state |
| `--_link` | `#533afd` | Link color — matches accent |
| `--_success` | `#059669` | Positive states |
| `--_warning` | `#d97706` | Warning states |
| `--_danger` | `#dc2626` | Error/danger states |

### Dark Mode (`html.dark`)

| Token | Value | Usage |
|-------|-------|-------|
| `--_surface` | `#1e293b` | Dark background |
| `--_surface-alt` | `#0f172a` | Deeper dark |
| `--_accent` | `#7a5af8` | Lighter purple for dark mode |
| `--_accent-hover` | `#9b8afb` | Purple hover in dark |
| `--_link` | `#7a5af8` | Link in dark mode |

### Stripe Purple Palette (Tailwind `stripe-*`)

```
stripe-50:  #f5f3ff    stripe-500: #7a5af8
stripe-100: #ede9fe    stripe-600: #533afd  ← Primary accent
stripe-200: #ddd6fe    stripe-700: #4529e6
stripe-300: #c4b5fd    stripe-800: #3b1fc7
stripe-400: #a78bfa    stripe-900: #2e1a9e
                       stripe-950: #1a0f5e
```

### Navy Palette (Tailwind `navy-*`) — for footer, dark surfaces

```
navy-800: #243b53
navy-900: #0a2540  ← Footer background
navy-950: #061b30
```

## 3. Typography

| Role | Font | Weight | Usage |
|------|------|--------|-------|
| Display/Hero | Space Grotesk | 300 (light) | Page titles, hero headings |
| Display bold | Space Grotesk | 500 | Emphasized display text |
| Body | Inter | 400 | Body text, paragraphs |
| Body bold | Inter | 600-700 | Labels, buttons, nav |
| Data/Tables | Inter | 400 (tabular-nums) | Financial figures, tables |

**Key typographic decisions:**
- Headlines use weight **300** (light), not bold — this is Stripe's signature. Bold emphasis uses weight 500 at most.
- `font-variant-numeric: tabular-nums` on all financial data for proper alignment
- Font loading: Space Grotesk from Google Fonts (`display=swap`), Inter via local woff2 + Google Fonts fallback

### CSS Font Stacks
```css
--font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif;
--font-display: 'Space Grotesk', ui-sans-serif, system-ui, -apple-system, sans-serif;
```

## 4. Shadows (Blue-tinted, Stripe-style)

All shadows use `rgba(50,50,93,*)` base instead of pure black — this is the core of the Stripe aesthetic.

| Token | Value | Usage |
|-------|-------|-------|
| `shadow-stripe-sm` | `0 1px 3px rgba(50,50,93,0.08), 0 1px 2px rgba(0,0,0,0.04)` | Subtle elevation |
| `shadow-stripe` | `0 4px 6px rgba(50,50,93,0.11), 0 1px 3px rgba(0,0,0,0.08)` | Cards, surfaces |
| `shadow-stripe-md` | `0 6px 12px rgba(50,50,93,0.1), 0 3px 6px rgba(0,0,0,0.06)` | Dropdowns, popovers |
| `shadow-stripe-lg` | `0 13px 27px rgba(50,50,93,0.12), 0 8px 16px rgba(0,0,0,0.06)` | Modals, dialogs |
| `shadow-stripe-xl` | `0 30px 60px rgba(50,50,93,0.15), 0 18px 36px rgba(0,0,0,0.08)` | Hero elements |

## 5. Border Radius

Conservative, professional — not playful bubbles.

| Element | Radius |
|---------|--------|
| Buttons, inputs | `6px` (`rounded-stripe`) |
| Cards | `6px` |
| Modals | `8px` |
| Pills, tags | `9999px` (`rounded-full`) |
| Sub-nav items | `12px` (`rounded-xl`) |

## 6. Focus & Accessibility

- Focus ring: `2px solid #533afd` with `2px offset` (Stripe purple)
- Contrast: 4.5:1 minimum for normal text, 3:1 for large text
- All interactive elements must have accessible names
- Dark mode: every visual element has a `dark:` variant
- `prefers-reduced-motion`: all animations/transitions disabled

## 7. Navigation — Unified Accent

All 6 navigation tabs use the **same** `stripe-600` accent color (light) / `stripe-400` (dark). Tab identity comes from icons and labels, not color differentiation.

Active states:
- Top nav: `text-stripe-600` + `h-0.5 bg-stripe-600` bottom bar
- Sub-nav: `bg-stripe-100 text-stripe-700 ring-1 ring-stripe-300` (light)
- Mobile: `text-stripe-600` + `bg-stripe-600` top bar

## 8. Do & Don't

### Do
- Use `shadow-stripe-*` for all elevations
- Keep headings at weight 300-500, never 700+
- Use `stripe-600` as the unified accent everywhere
- Let whitespace breathe between sections
- Use `tabular-nums` on all financial data

### Don't
- Don't use rainbow tab colors (each tab having its own color)
- Don't use rounded-2xl or larger on cards — keep it sharp (6px)
- Don't use pure black shadows — always blue-tinted
- Don't use bold (700+) on display headings
- Don't add decorative gradients or blob backgrounds

## 9. Implementation Notes

### Color Migration Map

All previous accent colors now map to `stripe-*`:
- `indigo-*` → `stripe-*`
- `violet-*` → `stripe-*`
- `purple-*` → `stripe-*`
- `blue-*` (UI accent) → `stripe-*`

Semantic colors are preserved:
- `emerald-*` → success/positive (unchanged)
- `amber-*` → warning (unchanged)
- `red-*` → error/danger (unchanged)
- `green-*` → positive indicators (unchanged)

### Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-11 | Stripe theme selected | User chose from 4 brand proposals (Wise, Revolut, Stripe, N26) — Stripe won for authority and sophistication |
| 2026-04-11 | Unified nav accent | Replaced 6 individual tab colors with single stripe-600 — Stripe doesn't use rainbow tabs |
| 2026-04-11 | Space Grotesk display font | Matches Stripe's lightweight heading aesthetic (weight 300) |
| 2026-04-11 | Blue-tinted shadows | Core Stripe visual signature — rgba(50,50,93,*) base |
