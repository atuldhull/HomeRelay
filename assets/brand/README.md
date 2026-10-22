# HomeRelay brand assets

| File | Use |
|---|---|
| `src/icon-light.svg`, `src/icon-dark.svg` | Add-on icon sources (house outline, three connected task nodes, amber "relay" signal) |
| `src/carousel.svg` | Carousel image source (portrait, 600×900) |
| `src/banner.svg` | Optional banner source (1200×600) |
| `addon/icon-light-<n>x<n>.png` | Required light icons, n = 64, 72, 88, 126, 180, 241 |
| `addon/icon-dark-<n>x<n>.png` | Optional dark icons, same sizes |
| `addon/carousel-1-600x900.png` | Required carousel image (at least one) |
| `addon/banner-1200x600.png` | Optional banner |

Regenerate the PNGs with `npm run brand:render`. It renders with the installed Chrome and checks each PNG's dimensions.

**Checked against Amazon's add-on package docs (2026-10-22):** sizes, PNG format and HTTPS delivery. The remote profile serves the images at `https://<domain>/assets/addon/<file>`. The icons contain only the HomeRelay mark (no tagline). No asset shows Amazon devices, logos or the Alexa name.

**Not verifiable from the docs:** file-size limits and transparency rules are not stated. The icons are opaque RGB (no alpha), 1–20 KiB. The carousel is 70 KiB and the banner 177 KiB. Re-check against the add-on package validation that `alexa-ai deploy` runs.

**Carousel alt text** (≤ 250 characters): "HomeRelay showing a delivery situation with connected tasks and a plan waiting for approval in the HomeRelay app."
