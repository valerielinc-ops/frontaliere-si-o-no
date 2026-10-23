---
name: Frontaliere Ticino
description: A clear, trustworthy toolkit for cross-border work and life in Switzerland.
colors:
  primary: "#533afd"
  primary-hover: "#4529e6"
  primary-soft: "#f5f3ff"
  surface: "#ffffff"
  surface-alt: "#f8fafc"
  surface-raised: "#f1f5f9"
  heading: "#0f172a"
  strong: "#1e293b"
  body: "#334155"
  subtle: "#475569"
  muted: "#64748b"
  edge: "#e2e8f0"
  success: "#059669"
  warning: "#d97706"
  danger: "#dc2626"
  info: "#0d9488"
  neutral: "#57534e"
  footer-navy: "#0a2540"
  on-accent: "#ffffff"
typography:
  display:
    fontFamily: "'Space Grotesk', ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  body:
    fontFamily: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.5
rounded:
  compact: "6px"
  control: "8px"
  comfortable: "12px"
  card: "16px"
  feature: "24px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
  button-secondary:
    backgroundColor: "{colors.surface-alt}"
    textColor: "{colors.body}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "10px 20px"
  input-text:
    backgroundColor: "{colors.surface-alt}"
    textColor: "{colors.strong}"
    typography: "{typography.body}"
    rounded: "{rounded.comfortable}"
    padding: "10px 12px"
  chip-selected:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  card-metric:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.heading}"
    rounded: "{rounded.compact}"
    padding: "16px"
  nav-active:
    textColor: "{colors.primary}"
    typography: "{typography.label}"
    padding: "12px 8px"
---

# Design System: Frontaliere Ticino

## Overview

**Creative North Star: “Precise. Authoritative. Trustworthy.”**

The visual system combines restrained fintech cues with practical clarity for people navigating cross-border work and financial decisions. White and slate surfaces, clear typography, and a recognizable purple accent keep calculators, job flows, and guidance approachable while giving estimates an appropriately careful presentation.

The interface uses semantic color tokens that adapt to light and dark mode. Space Grotesk gives headings and prominent figures a distinct voice; Inter keeps controls, tables, and longer reading comfortable. The system supports dense information, but gives each tool and content section room to breathe.

**Key Characteristics:**
- Precise hierarchy for financial and practical information.
- Purple as the shared interaction accent, with semantic colors for status and section context.
- Responsive layouts that keep the next useful action close to the information it supports.

## Colors

The light palette pairs a vivid Stripe-inspired purple with cool slate neutrals; dark mode shifts surfaces and text while keeping the same semantic roles.

### Primary
- **Electric Purple** (`#533afd`): Links, primary actions, focus indicators, and the active top-level navigation item.
- **Deep Purple** (`#4529e6`): Hover emphasis for the light theme.
- In dark mode, the accent shifts to `#7a5af8`, with `#9b8afb` for hover and `#a78bfa` for links.

### Neutral
- **Paper** (`#ffffff`): Main light surface.
- **Slate Mist** (`#f8fafc`) and **Raised Slate** (`#f1f5f9`): Grouped and elevated light surfaces.
- **Ink** (`#0f172a`), **Strong Slate** (`#1e293b`), **Body Slate** (`#334155`), **Secondary Slate** (`#475569`), and **Muted Slate** (`#64748b`): Text hierarchy in light mode.
- **Slate Edge** (`#e2e8f0`): Borders and dividers.
- **Navy** (`#0a2540`): Footer and selected dark surfaces.
- Dark surfaces use `#1e293b`, `#0f172a`, and `#334155`; headings use `#f1f5f9`, emphasized text `#e2e8f0`, body text `#cbd5e1`, and borders `#334155`.

### Semantic
- **Success** (`#059669`), **Warning** (`#d97706`), **Danger** (`#dc2626`), and **Information** (`#0d9488`) identify status and guidance. Their light and dark variants are defined by the semantic CSS tokens.
- **The Unified Navigation Accent Rule.** The six top-level tabs share the purple active state; section-specific accents remain available for meaningful product context.

## Typography

**Display Font:** Space Grotesk (`'Space Grotesk', ui-sans-serif, system-ui, -apple-system, sans-serif`)
**Body Font:** Inter (`'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif`)

**Character:** Space Grotesk distinguishes headings and prominent figures. Inter carries body copy, controls, and tables with a neutral, readable rhythm.

### Hierarchy
- **Display** (usually 600–700, `1.875rem` and responsive sizes): Main page headings and prominent figures.
- **Headline** (600–700, commonly `1.25rem`–`1.5rem`): Section headings and card titles.
- **Body** (400, `1rem`): Explanatory copy, forms, and longer reading.
- **Label** (600, `0.75rem`–`0.875rem`): Compact control labels, table headings, and metadata.
- Financial figures and tabular data use tabular numerals for alignment.

## Layout

The product uses a responsive, content-first layout. On narrow screens, navigation and controls remain touch-friendly and content stacks into a readable flow; larger screens use wider grids and persistent navigation. Breakpoints follow Tailwind's `sm` through `2xl` scale, with project-specific `xlc` (1200px) and `xlw` (1400px) breakpoints for article layouts. Keep the operational answer, live data, or main action close to the page heading.

## Elevation & Depth

Depth comes from slate surface changes, fine borders, and a restrained family of blue-tinted shadows. The `shadow-stripe-*` tokens cover compact cards through overlays; individual components also use Tailwind's standard shadow utilities, including deeper shadows for some dialogs.

### Shadow Vocabulary
- **Subtle** (`0 1px 3px rgba(50,50,93,0.08), 0 1px 2px rgba(0,0,0,0.04)`): Compact cards and resting surfaces.
- **Standard** (`0 4px 6px rgba(50,50,93,0.11), 0 1px 3px rgba(0,0,0,0.08)`): General card elevation.
- **Raised** (`0 6px 12px rgba(50,50,93,0.1), 0 3px 6px rgba(0,0,0,0.06)`): Popovers and raised panels.
- **Overlay** (`0 13px 27px rgba(50,50,93,0.12), 0 8px 16px rgba(0,0,0,0.06)`): Strong elevation token; some dialogs use Tailwind's deeper `shadow-2xl` utility.

## Shapes

The CSS defines a 6px Stripe radius token, while implemented controls commonly use 8–12px and cards range from 6–24px depending on the surface. Use compact corners for controls and data panels, and reserve larger radii for prominent feature cards. Pills use fully rounded ends. Borders are generally thin and low-contrast.

## Components

### Buttons
- **Primary:** Purple fill, white text, medium-to-semibold label, and a compact 8–12px radius. Hover uses the theme's stronger accent token.
- **Secondary:** Surface or raised-surface fill, edge border, and body text; hover shifts the surface or accent border.
- **Focus:** A 2px purple outline with a 2px offset; interactive controls retain a visible keyboard focus state.
- Common touch controls use a minimum 44px target where the layout permits.

### Chips
- **Style:** Compact, rounded filter controls. Unselected chips use neutral surfaces and borders; selected chips use the strong accent and white text.

### Cards / Containers
- **Style:** Surface or raised-surface background with a fine edge border; data panels may use the subtle Stripe shadow.
- **Shape:** 6–16px is common for data cards; larger feature cards may use 24px.
- **Spacing:** Internal padding commonly uses 12–24px and adapts to the viewport.

### Inputs / Fields
- **Style:** Surface-alt fill, edge border, and 8–12px radius.
- **Focus:** Purple outline with a 2px offset; errors and statuses use semantic colors.

### Navigation
- The sticky top navigation uses a shared purple active label and underline, with muted inactive labels. The active state is not distinguished by color alone: labels and icons remain present. On mobile, navigation becomes a compact touch-oriented control.

### Motion and Interaction
- Control-state transitions commonly use 150ms; broader navigation and surface transitions use 300ms with `cubic-bezier(0.4, 0, 0.2, 1)`.
- `prefers-reduced-motion` reduces animation and transition durations to `0.01ms` and disables smooth scrolling.

## Admin panel (Operate surface)

The owner-admin panel is a private, operational surface built from the `components/admin` modules. It uses the same semantic light/dark system as the public product, but has its own navy rail and a denser information hierarchy. The canonical surface is Italian and is not duplicated per locale.

### Structure

`AdminShell` has two responsive shells, with the breakpoint at 1024px (`lg`):

| Viewport | Structure | Behavior |
| --- | --- | --- |
| Desktop, ≥1024px | Fixed navy side rail, 248px wide, plus a sticky top bar | The rail has five groups. The top bar shows the group/section path, `Copia link`, and the navigation/search palette with `⌘K` (also `Ctrl+K`); the current URL is exposed in the wider desktop header. |
| Phone, <1024px | Compact sticky header, horizontally scrollable section chips, and a fixed five-item bottom tab bar | The header keeps the current section visible; chips show the sections in the current group; the bottom bar uses the `env(safe-area-inset-bottom)` safe area. The same palette is available from the compact header. |

The five groups and their live section slugs are:

| Group | Sections |
| --- | --- |
| Oggi | Oggi (root section) |
| Lavoro | Crawler, Automazioni, Configurazione crawler |
| Aziende | Aziende, Candidature |
| Redazione | Redazione, Giornalisti, Newsletter |
| Sistema | Salute, Flag, Registro |

The Oggi home places `Tabellone delle esecuzioni` and `Tocca a te` in one grid from 1280px (`xl`) upward. Below that threshold they stack, with the actionable triage surface first on narrow layouts. The board switches from its table to cards on smaller screens.

### Semantic shell tokens

The shell-specific CSS intermediates live in `index.css` as `--_admin-*` variables. Their `@theme` aliases expose Tailwind utilities; light and dark values switch through the `html.dark` block without a `dark:` class in admin markup.

| CSS intermediate | Light | Dark | Tailwind alias and use |
| --- | --- | --- | --- |
| `--_admin-rail` | `#0a2540` | `#061b30` | `--color-admin-rail`; `bg-admin-rail` for the desktop rail and compact phone header |
| `--_admin-rail-ink` | `#f8fafc` | `#f1f5f9` | `--color-admin-rail-ink`; `text-admin-rail-ink` for brand and active rail text |
| `--_admin-rail-muted` | `#cbd5e1` | `#cbd5e1` | `--color-admin-rail-muted`; `text-admin-rail-muted` for group labels and inactive rail text |
| `--_admin-rail-active` | `rgba(167, 139, 250, 0.18)` | `rgba(167, 139, 250, 0.24)` | `--color-admin-rail-active`; `bg-admin-rail-active` for the selected rail item |
| `--_admin-rail-edge` | `rgba(255, 255, 255, 0.14)` | `rgba(226, 232, 240, 0.18)` | `--color-admin-rail-edge`; `border-admin-rail-edge` for the rail separator |

The rest of the shell composes these with the existing semantic aliases (`surface`, `surface-alt`, `surface-raised`, `heading`, `body`, `subtle`, `muted`, `edge`, `accent`, `on-accent`, and the status `success`/`warning`/`danger`/`info` families). These aliases are also declared in `@theme`, so components use utilities such as `bg-surface`, `text-subtle`, `border-edge`, and `bg-danger-subtle` rather than hard-coded colors.

### Components and interaction patterns

| Component or pattern | Implemented contract |
| --- | --- |
| `AdminShell` | Owns the rail, top bar, mobile header, section chips, bottom tabs, route-aware search palette, badges, and `Copia link`. The palette searches sections, actions, and operational data and is keyboard-navigable. |
| `AdminSectionHeader` | Provides the page title and summary plus one primary action slot. A view has one primary action and one `Aggiorna` control; secondary controls remain subordinate. |
| `AdminButton` | Shared action control with `primary`, `secondary`, and `danger` variants, common focus/disabled states, and a loading state with an explicit loading label. |
| `AdminStatusPill` | A rounded status pill with a current-color dot, an optional Lucide status icon, and text. Its tones are `success`, `danger`, `accent`, `warning`, `neutral`, and `info`. |
| Impact pills | Workflow actions expose the three impact labels `Solo lettura`, `Modifica dati`, and `Pubblica contenuti`, with distinct neutral, warning, and danger treatments and Lucide `Eye`, `Database`, and `Megaphone` icons. |
| `AdminConfirmDialog` | Uses a native dialog. The title names the human action (for example, “Rilancia workflow fallito”) and the confirmation button names the action too. It is centered on desktop; at phone width it becomes a bottom sheet and reserves the safe-area inset. |
| `AdminSkeleton` | Provides the loading state as pulsing, semantic-surface rows with an accessible status label. |
| `AdminPagination` | Keeps list pagination bounded and explicit: page number, total elements, and `Precedente`/`Successiva` controls; the default page size is 50. |
| Typed banners | `AdminMessageBanner` accepts the `AdminMessage` shape (`ok`, `warn`, or `error`) and maps it to status tokens and `status`/`alert` semantics. Source-health warnings use the same Italian, typed distinction. |

### Operate rules

- Keep admin text at 12px or larger. Use sentence case and neutral muted styling for table headings; use `tabular-nums` for counts, times, durations, IDs, and other aligned values.
- Failed rows use a `danger-subtle` background. Do not add colored side borders; the failure state is carried by the row surface, status pill, and action label.
- Render unavailable values as muted `—` or `n/d`, never as a visually prominent zero or an invented value.
- Do not use all-caps eyebrows, hero-metric callout boxes, or decorative hierarchy that competes with the operational answer. Regular surface cards carry metrics.
- Source errors are written in Italian and remain distinct from an empty state. For example, Oggi reports schedule/run source failures separately from `Nessuna esecuzione prevista oggi.` or `Niente da fare adesso`.
- At 390px the page must not overflow horizontally. Dense tables collapse to mobile cards or keep overflow contained inside the data region; controls remain usable touch targets.
- Use Lucide icons only. Icons reinforce labels and status; they do not replace the text contract.

### URLs and shareable state

Section identity is a stable slug from `ADMIN_SECTIONS`/`ADMIN_SECTION_SLUGS`. The canonical route is not locale-prefixed:

```text
/gestione-contenuti-xk9mp2q/
/gestione-contenuti-xk9mp2q/crawler/
/gestione-contenuti-xk9mp2q/registro/?azione=workflow_dispatch&dal=2026-10-01&al=2026-10-23
```

`adminSectionPath` always builds the Italian (`it`) admin path, and `canonicalAdminUrl` combines that path with the current query string and hash. Filters, selected records, focus targets, and command-palette destinations use the query string through `replaceAdminQuery`, so an admin state can be copied and reopened. Examples include `q`, `stato`, `azienda`, `ordine`, `azione`, `dal`, `al`, and `focus`.

The build emits one static shell for every live admin slug under the canonical route. Each shell is marked `noindex, nofollow`; planned or unknown sections do not become indexable pages.

### Release control

`admin_shell_v2` is the Firebase Remote Config switch for the fused shell. Its local/default value is `false`, so the legacy shell remains the fallback. On the admin route only, `?shell=v2` or `?shell=v1` takes precedence over Remote Config and provides the emergency override. If Remote Config cannot be read, the resolver fails closed to `v1`.

### Decisions Log

| Date | Decision |
| --- | --- |
| 2026-10-23 | Owner approved the fused Operate shell, combining the Regia, Tabellone, and Tascabile proposals. |

## Do's and Don'ts

### Do:
- **Do** use semantic surface, text, accent, and status tokens so light and dark themes stay coordinated.
- **Do** use tabular numerals for financial values and tables.
- **Do** preserve visible keyboard focus and reduced-motion behavior.
- **Do** keep normal-text contrast at least 4.5:1 and large-text contrast at least 3:1.
- **Do** keep the shared top-level navigation accent consistent; use section colors only where they carry meaning.

### Don't:
- **Don't** hardcode light-theme colors where a semantic token exists.
- **Don't** make status, chart, or section meaning depend on color alone.
- **Don't** use large radii as the default for compact controls or dense data panels.
- **Don't** remove reduced-motion or keyboard-focus treatments from interactive components.
