# Firstlight design system

An operations console for routing relief money. The visual language comes from **road signage**: the typeface (Overpass) descends from US highway-sign lettering, and the colours, shapes and status marks are the ones people already read on the road. Light theme; no dark mode.

Not based on a comparison with other sites; derived from the subject. Tokens live in `src/app/globals.css` (`@theme`). Components use token names, never raw values (exceptions: Leaflet and AG Grid, which take hex values, listed in their files).

## Colour

| Token | Value | Role |
|---|---|---|
| `ground` | `#E5E9E7` | Page background: concrete grey, cool, not cream |
| `panel` | `#FFFFFF` | Content surfaces |
| `raised` | `#F1F4F2` | Row hover, table headers, quiet fills |
| `line` | `#B9C1BD` | Input and button borders |
| `line-soft` | `#D8DEDB` | Dividers, panel borders |
| `ink` | `#000000` | Text and headings (true black, like sign lettering) |
| `ink-muted` | `#3F4744` | Secondary text (9.6:1 on white) |
| `ink-dim` | `#5E6864` | Tertiary text, hashes (5.9:1 on white) |
| `allow` | `#0B6E4F` | **Guide-sign green.** Primary buttons, links, "allowed", "paid" (6.4:1 with white) |
| `allow-wash` | `#DCEFE7` | Success notice background |
| `hold-fill` | `#FFC72C` | **Warning yellow.** "Needs approval" plates, warning diamonds, sandbox badge. Always with black text |
| `hold` | `#7A5100` | Warning-coloured text on white (7.3:1) |
| `hold-wash` | `#FFF4D1` | Warning notice background |
| `block` | `#C8102E` | **Regulatory red.** "Blocked", errors, deny (5.9:1 with white) |
| `block-wash` | `#FBE3E6` | Error notice background |
| `route` | `#0B4A8F` | **Interstate blue.** The payout route on the map and focus rings |

Map payout bands: A `#E35205` (solid), B `#C99700` (solid), C `route` (dashed). PAGER alert dots use USGS PAGER colours with a black outline so yellow reads on white.

## Status

Status is shape **and** colour, as on signs, so it reads without colour vision:

| State | Plate | Mark |
|---|---|---|
| Allowed / approved / paid | Solid green, white text | Circle with a check |
| Needs approval / sending | Solid yellow, black text | Diamond with "!" |
| Blocked / failed / denied | Solid red, white text | Octagon with a bar |
| Not reached / not in plan | Grey outline | Hollow circle |

## Typography

Overpass only (variable, 300–900). Tabular, lining figures for every amount (`.num`).

| Use | Size / line height | Weight |
|---|---|---|
| Body | 16 / 1.55 | 400 |
| Small, table cells | 14 / 1.45 | 400 |
| Meta, hashes | 13 / 1.4 | 400 |
| Section heading | 18 / 1.3 | 700 |
| Page heading | 24 / 1.2 | 800 |
| Magnitude | 44 / 1 | 800 |

Sentence case everywhere. No uppercase labels. Lines ≤ 75 characters for prose.

## Spacing and shape

4-px base: 4, 8, 12, 16, 20, 24, 32, 48. Content max width 1500 px, 16 px side gutter on phones, 24 px from tablet up.

Radius: chips and buttons 4 px (sign plates have rounded corners), panels 6 px, map and tables 0. No shadows except the rule drawer.

## Components

- **Buttons:** primary = green plate, white text. Secondary = white, `line` border, black text. Destructive = white, red border, red text. Hover darkens the border; focus is a 2 px `route` ring; disabled at 45 % opacity.
- **Money's path:** a green guide-sign board with a white inset border; stages in white type; marks per the status table.
- **Inputs:** white, `line` border, explicit `<label for>`.
- **Navigation:** text links, active page underlined in black; below 768 px a "Menu" button opens the list.
- **Sandbox badge:** yellow warning plate with a black border, always visible.

## Imagery and icons

No illustrations or stock imagery. Icons are the sign marks above, drawn inline as SVG. The map uses standard OpenStreetMap tiles, slightly desaturated so status markers stand out.
