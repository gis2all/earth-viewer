---
version: alpha
name: Earth Viewer
description: Existing visual and interaction constraints for the Earth Viewer web application.
colors:
  dark:
    background: "#0a0b0e"
    surface: "#05070d"
    surface-hover: "#121722"
    surface-muted: "#0e1014"
    text: "#eceef2"
    text-muted: "#9aa0ad"
    text-faint: "#6c7282"
    border: "rgba(235,238,245,.09)"
    border-strong: "rgba(235,238,245,.17)"
    accent: "#6e79d6"
    accent-strong: "#8690f0"
    scrollbar: "#1a1f29"
  light:
    background: "#fafbfc"
    surface: "#ffffff"
    surface-hover: "#f1f3f6"
    surface-muted: "#f7f8fa"
    text: "#252b35"
    text-muted: "#626a78"
    text-faint: "#7b8491"
    border: "rgba(37,43,53,.10)"
    border-strong: "rgba(37,43,53,.18)"
    accent: "#4e59c8"
    accent-strong: "#3d47ad"
    scrollbar: "#e8ebef"
  semantic:
    added-dark: "#a59bf2"
    added-light: "#6557c7"
    danger-dark: "#e5534b"
    danger-light: "#c92a2a"
typography:
  body:
    fontFamily: "PingFang SC, Microsoft YaHei, Segoe UI, system-ui, sans-serif"
    fontSize: 13px
    lineHeight: 1.5
  label:
    fontSize: 12px
    fontWeight: 400
  section:
    fontSize: 11px
    fontWeight: 600
spacing:
  card-gap: 8px
  panel-content-left: 16px
  panel-content-right: 10px
  control-row-vertical: 9px
sizing:
  header-height: 52px
  left-panel-width: "clamp(320px, 20vw, 423px)"
  right-panel-width: "clamp(240px, 14vw, 304px)"
  scrollbar-width: 7px
  icon-button: 32px
  small-icon: 15px
  card-title-row: 28px
  card-action-row: 26px
rounded:
  all: 0
---

## Overview

Earth Viewer is a focused 3D globe workspace. Cesium owns the globe and ArcGIS Online supplies searchable map content. The interface should feel like a precise map tool: quiet surfaces, hard edges, compact controls, and one restrained purple accent.

This file describes the existing implementation. It is the visual source of truth for agents making UI changes; it is not a proposal for a new visual direction.

## Design Direction

- Use a neutral monochrome foundation in both themes. The globe, panels, search field, cards, and top bar share the same surface family for the active theme.
- Use the theme accent only for actionable emphasis: focused controls, detail/add actions, active switches, and selected or added states.
- Keep the geometry hard and technical. Borders and controls are square; do not introduce rounded cards, pill controls, decorative gradients, or floating blobs.
- Prefer familiar SVG icons over text glyphs. Icons are compact, centered, and optically aligned with neighboring controls.

## Themes

Dark mode uses `dark.surface` (`#05070d`) for the globe and all panels. Light mode uses `light.surface` (`#ffffff`) for the same surfaces. Text, borders, hover surfaces, accent colors, and scrollbar colors must switch as a set; do not mix dark and light theme values.

The scrollbar is intentionally visible enough to distinguish the scrollable panel without becoming a second visual surface. It is 7px wide, square, transparent-track, and uses the theme scrollbar token. The panel's top and bottom arrow controls reuse that same token. Hovering a scrollbar or arrow may use the muted text color, but must not turn purple.

## Layout

- The top bar is 52px high with 16px horizontal padding.
- The left layer panel is `clamp(320px, 20vw, 423px)` wide (20% of viewport width, capped at 320–423px); its scroll content is `calc(100% - 6px)` with 16px left and 10px right padding.
- The right effects panel is `clamp(240px, 14vw, 304px)` wide (14% of viewport width, capped at 240–304px); its scroll content is `calc(100% - 6px)` with 14px inline padding.
- Collapsed panels slide fully off-screen via a horizontal `transform: translateX` animation (left −100%, right +100%, 220ms). The panel keeps its final width throughout, so inner content never reflows during the transition; do not regress to a width-based animation. The expand controls remain 24px square and use the same icon treatment as the panel fold controls.
- The gallery is a two-column grid with an 8px gap. The card width is fluid within the panel.

## Components

### Top Bar

The top bar contains the brand mark, orient/reset view actions, theme toggle, immersive-mode toggle, and GitHub link. Icon buttons are 32px square with 14-15px SVG drawings. Default icons use the muted text color; hover uses the theme foreground and a subtle theme hover surface. The GitHub mark is centered in its button and links to the project repository.

### Layer Card

Each card has a 3:2 thumbnail, a 28px title row, and a 26px action/status row. The card grid gap is 8px. Titles are one line with ellipsis overflow; the full title is available through a tooltip/title attribute.

The bottom row has status icons on the left and two independent actions on the right:

- The detail icon is a 20px square link using a simple list-style SVG. It opens the ArcGIS item page and is aligned to the add action.
- The add action is a 20px square button with no default border or background. Its base color is the theme accent. Loading uses the same footprint and a compact spinner. Added uses the semantic added color and does not gain a filled background.

The card body is not an add target. Adding a layer happens only through the add button. Detail navigation happens only through the detail link. Hover must not translate, resize, or otherwise move the card; it may change border and surface colors only. In dark mode the hover surface must remain visibly distinguishable from the base surface.

### Effects Panel

Effects are grouped under `环境`, `地形`, and `视图`. Labels use the muted theme text. Switches and sliders are compact, square, and aligned to the right edge. The terrain exaggeration value uses the same regular 12px label styling as other effect labels. A dependent slider is hidden when its controlling switch is off.

### Panel Controls

Fold and expand controls are 24px square, borderless by default, with a 16px SVG chevron. The chevron is a real acute-angle SVG path, not a text `<` glyph. The left and right controls mirror direction but share size, stroke, color, hover, and focus behavior.

### Immersive Mode

Immersive mode hides the top bar and both side panels, leaving the globe and one 32px exit icon. It is session-only and can be exited with the icon or `Escape`.

## Interaction States

- **Default:** muted icons and labels, transparent icon-button backgrounds, theme surfaces.
- **Hover:** foreground icon/text and a subtle theme hover surface; no purple highlight for non-functional status icons and no layout shift.
- **Focus:** preserve a clearly visible 2px accent focus outline with a 2px offset.
- **Loading:** preserve the action footprint; show a compact spinner and use a wait cursor.
- **Added:** use the theme semantic added color, with no filled rectangle behind the icon.
- **Disabled/error:** reduce disabled controls' opacity; errors use the theme danger token and remain readable.

## Accessibility and Consistency

- Every unfamiliar icon button or icon link has a `title` and an accessible label.
- Do not rely on color alone for an action's meaning; keep the icon shape and accessible name stable across themes.
- Keep icon drawings optically centered and aligned along the same baseline within a row.
- Preserve single-line truncation for card titles and keep the full title discoverable via tooltip.
- Maintain visible keyboard focus and do not remove native button/link semantics.

## Behavioral Boundaries

- Keep ArcGIS item metadata semantics authoritative: the authoritative badge comes from `contentStatus`; Living Atlas comes from `groupDesignations`, not a guessed `typeKeywords` value.
- Keep Cesium in demand-render mode (`requestRenderMode: true`, `maximumRenderTimeChange: Infinity`). Request a frame after actual scene changes; do not reintroduce unconditional rendering while the globe is idle.
- Keep the current layer safety budgets, cancellation paths, and render queue error handling. A visual change must not bypass those limits.

## Do Not Regress

- Do not make the whole card clickable for adding data.
- Do not restore rounded corners, large shadows, decorative gradients, or purple hover backgrounds for ordinary controls.
- Do not change the two-column gallery, 8px card gap, compact title/action row heights, or independent detail/add actions without updating this document first.
- Do not hide the scrollbar arrows, change their color independently, or make the scrollbar a rounded pill.
- Do not use a fallback port when 5173 is occupied; stop the listener and restart with `--strictPort`.
