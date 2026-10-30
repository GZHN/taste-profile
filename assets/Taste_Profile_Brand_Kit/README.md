# Taste Profile - Brand Kit

## Contents
- `logo/`: primary transparent SVG/PNG, light-background variant, white and black monochrome, high-resolution raster, vector PDF, and flattened-background JPEG.
- `icon/`: matching extracted symbol (transparent SVG/PNG), dark and light rounded-square app icons (SVG, PNG sizes 64-1024, PDF).
- `favicon/`: ICO containing multiple sizes, favicons 16/32/48/64, Apple touch icon 180, Android icons 192/512.
- `guidelines/`: visual preview and brand guidance.

## Color specifications
- Primary mint-green sampled from the approved logo: `#26F98B` (vector approximation).
- Dark UI: `#121212`.
- White: `#FFFFFF`.
- Ink: `#141414`.
- Deep green for legibility on white backgrounds: `#087C4E`.

## Usage
- Spicetify Custom App header and README: `logo/taste-profile-logo-primary.svg` on dark surfaces.
- White/light surfaces: `logo/taste-profile-logo-light.svg`.
- Spotify sidebar or small badges: `icon/taste-profile-mark-primary.svg` on dark backgrounds.
- App stores and square surfaces: `icon/taste-profile-app-icon-dark-512.png` or SVG.
- Website favicon: `favicon/favicon.ico` and `favicon/favicon-32.png`.
- Closest match to original generated graphic: `logo/taste-profile-logo-approved-transparent-2400w.png`.
- High-DPI raster: prefer the 2400w transparent logo, or render SVG to required dimensions.
- Print: vector PDF, EPS, or SVG. Verify against the original reference at large sizes because these are traced outlines, not source Bézier curves.

## Branding rules
- Preserve icon and wordmark proportions; do not stretch.
- Clear space around the logo: at least 15% of the mark height.
- Keep text legible at small sizes; use icon alone when the full lockup cannot be read.
- Prefer full-color variants on dark backgrounds; use the adjusted deep-green/light version on white backgrounds.
- Icons with 16px details are necessarily limited. For small size rendering, visually inspect a favicon before release.

## Transparency / vector accuracy notes
The approved artwork was supplied as a flattened raster with a dark background. Additional `approved-transparent` PNGs retain the original artwork color shading and antialiasing through a reconstructed transparency matte; use these for closest raster fidelity. SVGs here were vector-traced from foreground silhouettes, **not recovered from an original designer vector file**, and therefore use clean solid brand colors instead of raster glow/gradient. PNGs were rendered from these transparent vector recreations. The untouched source raster is not in this folder.
The full horizontal wordmark is converted to vector paths, so recipients do not need a specific installed font.
