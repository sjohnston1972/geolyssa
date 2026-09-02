# Geolyssa — a pocket geologist

Mobile-first rock, mineral, fossil and meteorite identification. Point your camera, Claude Vision tells you what it is, with local bedrock context and diagnostic tests to confirm. Hosted entirely on Cloudflare at [geolyssa.clydeford.net](https://geolyssa.clydeford.net).

Single Cloudflare Worker, single HTML file, no build step for the frontend (React + Babel transform in-browser).

## The intelligence layer

Rock ID from a single photo is fundamentally harder than plant ID — basalt vs. gabbro, gneiss vs. schist, and limestone vs. dolomite can look identical. Geolyssa compensates with four signals beyond the pixels:

1. **Local bedrock context.** At scan time the Worker looks up the mapped bedrock unit at the user's coordinates and injects the lithology, unit name and age range into Claude's prompt.
   - Primary: [Macrostrat](https://macrostrat.org/) (global, strongest in North America)
   - UK fallback: [BGS 50k bedrock map](https://www.bgs.ac.uk/datasets/bgs-geology-50k/) via the WMS `GetFeatureInfo` endpoint — kicks in automatically when Macrostrat has no coverage
2. **Optional physical tests.** The home screen has a collapsible panel for hardness (fingernail / coin / knife / glass / quartz — the Mohs ladder), streak colour, vinegar-drop fizz, magnetism, and heft. Any filled field is sent as authoritative context — a 0.4-confidence "maybe granite" becomes 0.8 "definitely granite" with Mohs 6+ and no acid reaction.
3. **Multi-photo capture.** If the first scan returns low confidence (< 0.65), the results screen surfaces an **Add fresh break** button. A second photo (tagged `fresh_break`) is appended to the request and the model re-identifies with both images as complementary views of the same specimen.
4. **Diagnostic tests in the result.** Claude returns up to 3 concrete field tests per match with expected results and what each rules in/out. Users can run them to confirm the identification.

Confidence is capped at 0.7 without physical tests; meteorites cap at 0.6 regardless, given how often terrestrial slag and magnetite get mistaken for chondrites.

Every bedrock card has a **Learn more ↗** link — BGS entries link to the BGS Lexicon page for the formation; Macrostrat entries link to the strat-name page or a Wikipedia search fallback.

## Architecture

```
public/index.html    — the whole frontend (React + Babel in-browser, no build step)
src/worker.js        — Worker routes: /api/identify, /api/bedrock, /api/journal, /api/photos
scripts/build.sh     — bundles public/index.html into build/worker.js as base64
scripts/deploy.sh    — uploads Worker, sets secret, binds custom domain, provisions D1+R2 via CF API
wrangler.jsonc       — config for wrangler CLI (optional)
```

**Storage.** D1 holds `journal_entries` keyed by an anonymous device UUID stored in the browser's localStorage. R2 holds the photos, referenced by key from the D1 row. Macrostrat/BGS context captured at scan time is persisted alongside the entry, so the detail screen can show "what was beneath you when you found this" months later. No user accounts, no auth — just the device UUID.

**No build step for the frontend.** `public/index.html` loads React UMD + Babel Standalone from unpkg and runs `<script type="text/babel">` blocks directly in the browser. One-file deploys, instant iteration, happy phone debugging. `scripts/build.sh` base64-encodes the HTML and prepends it as a constant to `src/worker.js`, which the Worker decodes at cold start.

## Screens

1. **Home** — camera viewfinder, Journal / Cam / Refresh pills across the top, capture button with radar ring, part selector (whole / fresh break / crystals / weathered), quick-tests panel, **Bedrock beneath you** card, recent-captures list (tap to jump into that entry's detail)
2. **Scan** — radar animation, status ticks through "reading grain" → "cross-referencing bedrock" → "narrowing"
3. **Results** — top-3 matches, confidence ring, safety badge, classification breadcrumb, bedrock context banner, low-confidence refinement card (**Add fresh break** / **Run a test**), Wikipedia verify sheet
4. **Detail** — overview / tests / similar tabs. The tests tab renders Claude's diagnostic tests as numbered cards with expected results. The alternatives and re-identify flows let the user flip the active ID on a saved entry without re-capturing
5. **Journal** — filtered list (All / Safe / Hazardous / Igneous / Sedimentary / Metamorphic / Minerals / Fossils / Meteorites), species count, per-entry thumbnails
6. **Map** — Leaflet map of pinned finds, emoji markers coloured by rock type, user-location dot

Theme: _Stratum_ (warm stone + sienna), Fraunces display + Inter body.

## Deploy

Copy `.env.example` to `.env` and fill in the three secrets. The Cloudflare token needs `Workers Scripts:Edit`, `Workers R2 Storage:Edit`, `D1:Edit`, and `Zone DNS:Edit` on the hosting zone.

```bash
bash scripts/deploy.sh
```

The script:

1. Bundles `public/index.html` into `build/worker.js` (base64, decoded at cold start — preserves multi-byte UTF-8 so em-dashes and emojis survive)
2. Ensures the R2 bucket (`geolyssa-photos`) exists
3. Ensures the D1 database (`geolyssa`) exists, applies schema + incremental `ALTER`s
4. Uploads the Worker with D1 + R2 bindings
5. Sets `ANTHROPIC_API_KEY` as a Worker secret
6. Binds the custom domain (auto-creates DNS + route)
7. Purges the zone cache

Override defaults with `GEOLYSSA_WORKER_NAME`, `GEOLYSSA_HOSTNAME`, `GEOLYSSA_ZONE_NAME`, `GEOLYSSA_R2_BUCKET`, `GEOLYSSA_D1_DB`.

## API

### `POST /api/identify`

Three input modes, all returning the same response shape:

```json
// single-photo scan
{
  "image": "data:image/jpeg;base64,...",
  "part": "whole" | "fresh_break" | "crystals" | "weathered",
  "coords": { "lat": 51.5, "lng": -0.1 },
  "tests": { "hardness": "knife", "streak": "white", "fizz": "yes", "magnetic": "no", "heft": "normal" }
}

// multi-photo scan (up to 4 images)
{
  "images": [
    { "image": "data:image/...", "part": "whole" },
    { "image": "data:image/...", "part": "fresh_break" }
  ],
  "coords": {...}, "tests": {...}
}

// re-identify a stored journal photo
{ "entry_id": "uuid", "device_id": "uuid", "coords": {...} }
```

Response:

```json
{
  "matches": [
    {
      "common_name": "Basalt",
      "scientific_name": "Mafic extrusive igneous",
      "rock_type": "igneous",
      "classification": ["Igneous", "Extrusive", "Mafic"],
      "confidence": 0.84,
      "formation": "Rapid cooling of basaltic lava",
      "composition": ["Plagioclase", "Pyroxene", "Olivine"],
      "hardness": "6",
      "diagnostic_tests": [
        { "test": "Weight", "expected_result": "Heavy for size", "why_it_helps": "rules out pumice" }
      ],
      "safety": { "level": "safe", "note": "Common, benign." },
      "similar": [
        { "common_name": "Gabbro", "scientific_name": "...", "differentiator": "Coarser grain — visible crystals." }
      ]
    }
  ],
  "macrostrat": {
    "source": "macrostrat" | "bgs",
    "unit": "...", "lithology": "...",
    "age_top": "...", "age_bottom": "...",
    "learn_more_url": "https://..."
  }
}
```

Up to 3 matches, ordered by confidence. Empty `matches` array if the image doesn't contain rock/mineral/fossil/meteorite subject matter.

### `GET /api/bedrock?lat=&lng=`

Standalone bedrock lookup used by the home-screen card. Tries Macrostrat, falls back to BGS on UK coords. Returns the same `macrostrat` shape as above, or `null` if neither source has coverage.

### `GET /api/journal?device_id=…`, `POST /api/journal`, `PATCH /api/journal/:id`, `DELETE /api/journal/:id`

Anonymous, device-scoped. Entries include the rock identification, location, photo reference, alternatives, and the bedrock context at scan time.

### `GET /api/photos/:key`

Serves R2 photos with long-lived cache headers. Key is validated to prevent path traversal.

### `GET /api/health`

Liveness ping.

## Local iteration

Edit `public/index.html`, run `bash scripts/deploy.sh`, refresh on your phone. For hot reload:

1. `npm i -g wrangler`
2. Apply the D1 schema to the local simulated database: `wrangler d1 execute geolyssa --local --file=schema.sql`
3. Copy `.dev.vars.example` to `.dev.vars` and fill in a real `ANTHROPIC_API_KEY` (git-ignored, never committed)
4. `wrangler dev` — `wrangler.jsonc` declares the `DB` (D1) and `PHOTOS` (R2) bindings `wrangler dev` needs, plus `.dev.vars` supplies `ANTHROPIC_API_KEY`; the journal, photos and identify routes all work locally against local-only simulated storage.

Mobile debugging: append `?debug=1` to the URL to load the [eruda](https://github.com/liriliri/eruda) on-device console. Preference persists via sessionStorage until you visit `?debug=off`.

## Attribution

- [Macrostrat](https://macrostrat.org/) for global geologic unit coverage
- [British Geological Survey](https://www.bgs.ac.uk/) (© UKRI) for UK 50k bedrock via their WMS
- [OpenStreetMap](https://www.openstreetmap.org/) contributors for map tiles
- [Wikipedia](https://www.wikipedia.org/) for reference photos in the "Verify" sheet
