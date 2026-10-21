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
