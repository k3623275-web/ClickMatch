# ClickMatch — Brand Guide

> Pixel Canvas Game | Global Competition | Phase 1

---

## 1. Logo

### Primary Logo (32×32 pixel-art SVG)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">
  <!-- Background: 4x4 grid of colored squares -->
  <rect x="2" y="2" width="6" height="6" fill="#00FF88"/>
  <rect x="9" y="2" width="6" height="6" fill="#FF4444"/>
  <rect x="16" y="2" width="6" height="6" fill="#4488FF"/>
  <rect x="23" y="2" width="6" height="6" fill="#FFCC00"/>
  <rect x="2" y="9" width="6" height="6" fill="#8844CC"/>
  <rect x="9" y="9" width="6" height="6" fill="#00FF88"/>
  <rect x="16" y="9" width="6" height="6" fill="#FF4444"/>
  <rect x="23" y="9" width="6" height="6" fill="#4488FF"/>
  <rect x="2" y="16" width="6" height="6" fill="#FFCC00"/>
  <rect x="9" y="16" width="6" height="6" fill="#8844CC"/>
  <rect x="16" y="16" width="6" height="6" fill="#00FF88"/>
  <rect x="23" y="16" width="6" height="6" fill="#FF4444"/>
  <rect x="2" y="23" width="6" height="6" fill="#4488FF"/>
  <rect x="9" y="23" width="6" height="6" fill="#FFCC00"/>
  <rect x="16" y="23" width="6" height="6" fill="#8844CC"/>
  <rect x="23" y="23" width="6" height="6" fill="#00FF88"/>
</svg>
```

**Concept**: A 4×4 grid of colored squares — the game's core atomic unit (the pixel) arranged in a pattern that reads as a stylized "C" and suggests the mosaic nature of collaborative pixel art.

### Favicon (16×16 simplified)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">
  <rect x="1" y="1" width="3" height="3" fill="#00FF88"/>
  <rect x="5" y="1" width="3" height="3" fill="#FF4444"/>
  <rect x="9" y="1" width="3" height="3" fill="#4488FF"/>
  <rect x="12" y="1" width="3" height="3" fill="#FFCC00"/>
  <rect x="1" y="5" width="3" height="3" fill="#8844CC"/>
  <rect x="5" y="5" width="3" height="3" fill="#00FF88"/>
  <rect x="9" y="5" width="3" height="3" fill="#FF4444"/>
  <rect x="12" y="5" width="3" height="3" fill="#4488FF"/>
  <rect x="1" y="9" width="3" height="3" fill="#FFCC00"/>
  <rect x="5" y="9" width="3" height="3" fill="#8844CC"/>
  <rect x="9" y="9" width="3" height="3" fill="#00FF88"/>
  <rect x="12" y="9" width="3" height="3" fill="#FF4444"/>
</svg>
```

### Wordmark

Type: "CLICKMATCH" — set in monospace/pixel font, tracking: wide (0.2em letter-spacing), all caps.

---

## 2. Brand Colors

| Role | Name | Hex | Usage |
|------|------|-----|-------|
| **Primary** | Pixel Green | `#00FF88` | Buttons, links, active states, logo accent |
| **Background** | Deep Void | `#0d0d1a` | Page background, cards |
| **Surface** | Void Light | `#16162b` | Cards, panels, inputs |
| **Border** | Void Border | `#2a2a4a` | Dividers, input borders |
| **Accent 1** | Alert Red | `#FF4466` | Errors, warnings, "out of balance" |
| **Accent 2** | Gold | `#DAA520` | Premium/paid indicators, rank badges |
| **Text Primary** | `#E8E8F0` | Body text on dark backgrounds |
| **Text Secondary** | `#8888AA` | Secondary labels, meta info |
| **Text Disabled** | `#555570` | Disabled/hint text |

---

## 3. 16-Color Palette Review

### Current palette

| # | Name | Hex | Review |
|---|------|-----|--------|
| 1 | Red | `#FF4444` | ✅ Good. Distinct and visible. |
| 2 | Orange | `#FF8800` | ✅ Good. |
| 3 | Yellow | `#FFCC00` | ⚠️ Low contrast on white canvas. Suggestion: `#FFD700` is brighter. Keep this but document. |
| 4 | Green | `#44CC44` | ✅ Good. |
| 5 | Cyan | `#00CCCC` | ✅ Good. |
| 6 | Blue | `#4488FF` | ✅ Good. |
| 7 | Purple | `#8844CC` | ✅ Good. |
| 8 | Pink | `#FF66AA` | ✅ Good. |
| 9 | White | `#FFFFFF` | ✅ Obvious include. Default canvas color. |
| 10 | Light Gray | `#CCCCCC` | ✅ Good. |
| 11 | Gray | `#888888` | ✅ Good. |
| 12 | Dark Gray | `#444444` | ✅ Good. |
| 13 | Black | `#000000` | ✅ Essential. |
| 14 | Brown | `#886644` | ✅ Good earth tone — uncommon inclusion, adds character. |
| 15 | Gold | `#DAA520` | ✅ Good. Distinct from yellow. |
| 16 | Sky Blue | `#88CCFF` | ✅ Good. Distinct enough from #4488FF. |

### Color Blindness Assessment

- **Protanopia (red-blind)**: Red→Brown similar, but Red is brighter than Brown. Orange→Yellow close. The 16-color range is large enough that most pairs remain distinguishable.
- **Deuteranopia (green-blind)**: Green→Brown similar, Cyan→Gray similar. Green and Brown sit opposite on the luminance scale in this palette, so they're still distinct.
- **Tritanopia (blue-blind)**: Blue→Cyan may merge, Purple→Pink may merge. Designers: avoid relying on blue/cyan contrast for critical information.

**Recommendation**: Keep the current 16-color palette as-is. It's well-balanced across the spectrum with good luminance range (white → black gradient). No changes needed for Phase 1. Add color name tooltips in the UI on hover.

---

## 4. UI Design Direction

### 1. Pixel-First Typography
Use monospace fonts for UI elements (`'JetBrains Mono', 'Consolas', monospace`). Headings and body text use `'Inter', system-ui, sans-serif` for readability. Pixel fonts (like `'Press Start 2P'`) should be reserved for the logo/wordmark only — never for body text (legibility nightmare at small sizes).

### 2. Sharp Edges, No Rounded Corners
The canvas is a grid of squares. The UI should mirror this: 2px border-radius everywhere, sharp input fields, square buttons. Drop shadows are hard-edged (`box-shadow: 4px 4px 0 rgba(0,255,136,0.15)`), not blurred. This reinforces the pixel-grid identity.

### 3. Color Picker Is the Hero
The bottom color toolbar should be the most visually prominent interactive element after the canvas. Each swatch is 32×32px with a 2px white border on hover. The active color gets a glow effect (`box-shadow: 0 0 12px currentColor`). Users should never wonder which color they have selected.

### 4. Minimal Chrome
The top bar is 48px, bottom bar is 56px. Everything between is canvas. No sidebars, no floating panels by default. Leaderboard is a slide-out drawer. Login modal is the only overlay. Respect the canvas as the primary real estate.

### 5. State Changes = Pixel Glow
Use the brand green `#00FF88` for positive feedback (pixel placed = green flash on the pixel position) and accent red `#FF4466` for errors. Animations are fast (150-200ms), snappy, and purposeful — no smooth transitions, no fading. The game feels responsive because it looks responsive.

---

## 5. Asset Deliverables

| File | Path | Format |
|------|------|--------|
| Logo SVG | `docs/assets/logo.svg` | SVG (crispEdges) |
| Favicon SVG | `docs/assets/favicon.svg` | SVG (16×16) |
| Brand Guide | `docs/brand.md` | This file |
