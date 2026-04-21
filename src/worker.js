// Geolyssa — Cloudflare Worker (bundled, no external assets)
//
// The frontend (public/index.html) is base64-encoded and prepended to this file
// by scripts/build.sh, defining a global `INDEX_HTML_B64` constant.
//
// Env bindings required (set via scripts/deploy.sh or wrangler):
//   ANTHROPIC_API_KEY — secret used for the Claude Vision call
//   DB                — D1 database (journal entries)
//   PHOTOS            — R2 bucket (captured photos)

// Decode to raw bytes (NOT a JS string) so multi-byte UTF-8 chars like em-dash
// and emojis survive the round-trip. Using a string + Response() would re-encode
// each binary byte as UTF-8, doubling the encoding.
// eslint-disable-next-line no-undef
const INDEX_HTML_BYTES = typeof INDEX_HTML_B64 !== 'undefined'
  ? Uint8Array.from(atob(INDEX_HTML_B64), c => c.charCodeAt(0))
  : new TextEncoder().encode('<h1>Not bundled — run scripts/build.sh</h1>');

const IDENTIFY_SYSTEM_PROMPT = `You are a field geologist identifying rocks, minerals, meteorites and fossils from photographs. For each image, return up to 3 plausible matches, ordered by confidence (highest first). Respond with JSON ONLY — no prose, no markdown fences.

Schema:
{
  "matches": [
    {
      "common_name": "string — the name a field geologist would use, e.g. 'Basalt', 'Rose Quartz', 'Banded Iron Formation'",
      "scientific_name": "string — mineralogical / petrological name where distinct, e.g. 'SiO₂ (quartz variety)' or '—'",
      "rock_type": "igneous" | "sedimentary" | "metamorphic" | "mineral" | "meteorite" | "fossil" | "other",
      "sub_type": "string — one level deeper, e.g. 'mafic extrusive' for basalt, 'clastic' for sandstone, 'foliated' for schist, 'silicate' for quartz",
      "classification": ["Igneous", "Extrusive", "Mafic"],
      "confidence": 0.0-1.0,
      "tagline": "one short sentence for the reader",
      "description": "2-3 sentences of useful field context — how it forms, where it's found, what it tells you about the landscape",
      "formation": "string — how this rock formed (e.g. 'Rapid cooling of basaltic lava at surface')",
      "age_typical": "string — geologic age range where this rock is commonly found (e.g. 'Archean to Holocene', 'Cambrian – Permian', '—' if not applicable)",
      "composition": ["primary minerals or components, e.g. 'Plagioclase feldspar', 'Pyroxene', 'Olivine'"],
      "texture": "string — grain size, fabric, e.g. 'Aphanitic (fine-grained)', 'Porphyritic', 'Granoblastic', 'Clastic, medium-grained'",
      "hardness": "string — Mohs scale, e.g. '5.5 – 6', or '—' for rocks where hardness varies",
      "diagnostic_tests": [
        {
          "test": "string — e.g. 'Streak test', 'Dilute HCl (vinegar) drop', 'Fingernail scratch', 'Magnet', 'Fresh break examination'",
          "expected_result": "string — e.g. 'White streak', 'Vigorous fizz (carbonate)', 'Will scratch glass', 'Attracts a weak magnet', 'Glassy conchoidal fracture'",
          "why_it_helps": "string — what the test rules in or out"
        }
      ],
      "safety": {
        "level": "safe" | "caution" | "hazardous",
        "note": "one-sentence safety note. Flag asbestiform minerals (chrysotile, crocidolite, actinolite asbestos), radioactive (uraninite, monazite), arsenic-bearing (arsenopyrite, realgar, orpiment), mercury (cinnabar), lead (galena) or other handling risks. Use 'safe' for common rocks with no special handling."
      },
      "uses": "string — notable historical or current uses, or '—'",
      "tags": ["short", "tags", "like", "Volcanic", "Crystalline", "Fizzes in acid"],
      "similar": [
        {
          "common_name": "string",
          "scientific_name": "string",
          "differentiator": "one short sentence on how this look-alike differs — focus on a feature the user can actually check (grain size, hardness, streak, acid reaction, density, cleavage, colour on fresh surface)"
        }
      ]
    }
  ]
}

The "similar" array should hold up to 3 plausible look-alikes — rocks/minerals in the same family or with similar visual appearance. Always include the confusion pairs a geologist would warn about: basalt vs gabbro, limestone vs dolomite, gneiss vs schist, quartz vs calcite, pyrite vs chalcopyrite vs gold, obsidian vs tektite, etc.

Rock-type guidance:
- igneous: crystallised from molten rock (basalt, granite, rhyolite, obsidian, pumice, gabbro, diorite)
- sedimentary: deposited/lithified at surface (sandstone, limestone, shale, conglomerate, chalk, chert)
- metamorphic: transformed by heat/pressure (schist, gneiss, marble, slate, quartzite, eclogite)
- mineral: a specific crystal, not a rock (quartz varieties, calcite, pyrite, mica, garnet, feldspar)
- meteorite: extraterrestrial origin (chondrite, iron, pallasite) — extremely conservative, cap confidence at 0.6
- fossil: biological remnant in a rock matrix
- other: only if nothing else fits

Critical confidence rules:
- Rock identification from photo alone is FUNDAMENTALLY HARDER than plant ID. Visual features often cannot distinguish basalt from gabbro, gneiss from schist, or limestone from dolomite.
- Cap confidence at 0.7 unless physical test data is provided or the specimen has distinctive features (e.g. visible banding in gneiss, vesicles in pumice, garnet porphyroblasts, fossil imprints).
- When the image shows a weathered surface, explicitly note that a fresh break is needed for confirmation and reduce confidence.
- For meteorites: cap at 0.6 regardless — most "meteorite" photos are terrestrial slag, magnetite, or iron concretions.

When context is provided about the local bedrock (Macrostrat), the user's physical tests, or which face of the specimen they photographed, USE IT to narrow the identification and raise confidence if consistent. Call out conflicts explicitly in the tagline.

diagnostic_tests: suggest 2-3 concrete tests the user could do at home or in the field to CONFIRM your top match. Prefer tests they can actually perform (fingernail/coin/knife scratch, unglazed tile streak, vinegar/HCl drop, fridge magnet, heft-for-size). Explain what each test would tell them.

If you cannot identify the subject, return {"matches": []}.
If the image does not contain a rock, mineral, meteorite or fossil, return {"matches": []}.
Be conservative with confidence: 0.85+ only for textbook-clear specimens with distinctive features and consistent context.`;

// ── Bedrock context: Macrostrat (global, US-strong) → BGS (UK fallback) ──
// Both normalise to: { source, unit, lithology, description, age_top, age_bottom, age_top_ma?, age_bottom_ma? }

function wikipediaSearchUrl(name) {
  if (!name) return null;
  return `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(name)}`;
}

async function fetchMacrostratContext(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const url = `https://macrostrat.org/api/v2/geologic_units/map?lat=${lat}&lng=${lng}&scale=large`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const top = Array.isArray(data?.success?.data) ? data.success.data[0]
              : Array.isArray(data?.data) ? data.data[0] : null;
    if (!top) return null;
    const unit = top.name || top.strat_name || null;
    // Prefer Macrostrat's own strat-name page when we have the ID; fall back
    // to a Wikipedia search of the unit name which always resolves to
    // something readable.
    const learnMore = top.strat_name_id
      ? `https://macrostrat.org/lex/strat-names/${top.strat_name_id}`
      : wikipediaSearchUrl(unit);
    return {
      source: 'macrostrat',
      unit,
      lithology: top.lith || null,
      description: top.descrip || null,
      age_top: top.t_int_name || null,
      age_bottom: top.b_int_name || null,
      age_top_ma: top.t_int_age ?? null,
      age_bottom_ma: top.b_int_age ?? null,
      learn_more_url: learnMore,
    };
  } catch {
    return null;
  }
}

// BGS 50k Bedrock via WMS GetFeatureInfo. ArcGIS REST /query and /identify
// are explicitly disabled on this service — only the WMS extension is
// enabled, so we build a tiny BBOX around the point and ask for feature
// info at the center pixel in geo+json format.
async function fetchBGSContext(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Small BBOX (~1km box) so the 50k-scale layer renders. Scale limit kicks
  // in above ~1:100000, so keep the span tight.
  const half = 0.005;
  const bbox = `${lat - half},${lng - half},${lat + half},${lng + half}`;
  const W = 400, H = 400;
  const url = `https://map.bgs.ac.uk/arcgis/services/BGS_Detailed_Geology/MapServer/WMSServer`
    + `?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo`
    + `&LAYERS=BGS.50k.Bedrock&QUERY_LAYERS=BGS.50k.Bedrock`
    + `&CRS=EPSG:4326&BBOX=${bbox}`
    + `&WIDTH=${W}&HEIGHT=${H}&I=${W >> 1}&J=${H >> 1}`
    + `&INFO_FORMAT=application/geo%2Bjson&FEATURE_COUNT=1`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/geo+json' },
    });
    if (!res.ok) {
      console.error('BGS non-ok', res.status);
      return null;
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { console.error('BGS JSON parse failed', e, text.slice(0, 200)); return null; }
    const feat = data?.features?.[0];
    if (!feat) { console.error('BGS no feature in response'); return null; }
    const p = feat.properties || {};
    // Actual BGS field names: LEX_RCS_D is "<formation> - <lithology>" combined.
    // Split on the first " - " to recover the parts; fall back to short code.
    let unit = null, lithology = null;
    if (typeof p.LEX_RCS_D === 'string' && p.LEX_RCS_D.includes('-')) {
      const [u, ...rest] = p.LEX_RCS_D.split('-');
      unit = u.trim();
      lithology = rest.join('-').trim();
    } else if (p.LEX_RCS_D) {
      unit = p.LEX_RCS_D;
    } else if (p.LEX) {
      unit = p.LEX;
    }
    if (!lithology) lithology = p.BROAD_D || null;
    // Youngest = MIN_*, oldest = MAX_*. Prefer TIME_D (stage name) before PERIOD.
    const ageTop    = p.MIN_TIME_D || p.MIN_PERIOD || null;
    const ageBottom = p.MAX_TIME_D || p.MAX_PERIOD || null;
    // BGS Lexicon URL is an authoritative per-formation page. Fall back to
    // Wikipedia search if BGS didn't include one for this unit.
    const learnMore = (typeof p.LEX_WEB === 'string' && p.LEX_WEB.startsWith('http'))
      ? p.LEX_WEB
      : wikipediaSearchUrl(unit);
    return {
      source: 'bgs',
      unit,
      lithology,
      description: p.LEX_RCS_D || p.BROAD_D || null,
      age_top: ageTop,
      age_bottom: ageBottom,
      age_top_ma: null,
      age_bottom_ma: null,
      learn_more_url: learnMore,
    };
  } catch (e) {
    console.error('BGS fetch failed', e);
    return null;
  }
}

// Tries Macrostrat first (global), falls back to BGS (UK only). Both calls
// are sequential to avoid hammering services when Macrostrat already has
// good coverage (US, Canada, parts of Europe).
async function fetchBedrockContext(lat, lng) {
  const ms = await fetchMacrostratContext(lat, lng);
  if (ms) return ms;
  return fetchBGSContext(lat, lng);
}

function formatMacrostratContext(ctx) {
  if (!ctx) return '';
  const bits = [];
  if (ctx.unit) bits.push(`Mapped unit: ${ctx.unit}`);
  if (ctx.lithology) bits.push(`Lithology: ${ctx.lithology}`);
  if (ctx.age_top && ctx.age_bottom && ctx.age_top !== ctx.age_bottom) {
    bits.push(`Age: ${ctx.age_bottom} – ${ctx.age_top}`);
  } else if (ctx.age_top || ctx.age_bottom) {
    bits.push(`Age: ${ctx.age_top || ctx.age_bottom}`);
  }
  if (ctx.description) bits.push(`Description: ${ctx.description}`);
  if (!bits.length) return '';
  const sourceLabel = ctx.source === 'bgs'
    ? "British Geological Survey 50k bedrock map"
    : "Macrostrat geologic unit map";
  return `Local bedrock context (from ${sourceLabel} at the user's coordinates):\n${bits.join('\n')}\n\nNote: this is the mapped bedrock, but the user may be holding an erratic, cobble, or imported stone. Use this as a prior, not a constraint.`;
}

function formatPhysicalTests(tests) {
  if (!tests || typeof tests !== 'object') return '';
  const lines = [];
  const hardness = {
    fingernail: 'Scratched by fingernail (Mohs ≤ 2.5)',
    coin:       'Scratched by copper coin but not fingernail (Mohs 2.5 – 3.5)',
    knife:      'Scratched by steel knife but not coin (Mohs 3.5 – 5.5)',
    glass:      'Scratches glass (Mohs ≥ 5.5)',
    quartz:     'Scratches quartz (Mohs ≥ 7)',
  };
  if (hardness[tests.hardness]) lines.push(`Hardness: ${hardness[tests.hardness]}`);
  if (typeof tests.streak === 'string' && tests.streak.trim()) {
    lines.push(`Streak colour: ${tests.streak.trim().slice(0, 40)}`);
  }
  if (tests.fizz === 'yes') lines.push('Reacts with dilute acid (vinegar/HCl): YES — indicates carbonate');
  else if (tests.fizz === 'no') lines.push('Reacts with dilute acid: NO — rules out most carbonates');
  if (tests.magnetic === 'yes') lines.push('Magnetic: YES — contains magnetite or iron');
  else if (tests.magnetic === 'no') lines.push('Magnetic: NO');
  if (typeof tests.heft === 'string' && ['light', 'normal', 'dense'].includes(tests.heft)) {
    lines.push(`Heft for size: ${tests.heft}${tests.heft === 'dense' ? ' (unusually heavy — suggests metallic or dense minerals)' : ''}`);
  }
  if (!lines.length) return '';
  return `User's physical test results:\n${lines.join('\n')}\n\nThese are authoritative — identifications must be CONSISTENT with these results. If the top visual match conflicts, demote it.`;
}

const ALLOWED_PARTS = ['whole', 'fresh_break', 'crystals', 'weathered'];
const PART_LABEL = {
  whole: 'the whole specimen',
  fresh_break: 'a FRESH BROKEN surface (use this for mineral ID — weathering obscures true colour and texture)',
  crystals: 'a close-up of crystal or grain detail',
  weathered: 'a WEATHERED outer surface (may not reflect true mineralogy — ask the user for a fresh break to confirm)',
};

async function identify(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // Three input modes:
  //   1. { entry_id, device_id }       — re-identify stored R2 photo
  //   2. { image, part? }              — single fresh scan (original)
  //   3. { images: [{image, part?}] }  — multi-photo scan (fresh break, crystals, …)
  let photos = []; // each: { mediaType, base64, part? }
  if (body?.entry_id && body?.device_id) {
    if (!validateDeviceId(body.device_id)) return json({ error: 'Invalid device_id' }, 400);
    const row = await env.DB.prepare(
      `SELECT photo_key FROM journal_entries WHERE id = ? AND device_id = ?`
    ).bind(body.entry_id, body.device_id).first();
    if (!row || !row.photo_key) return json({ error: 'Entry or photo not found' }, 404);
    const obj = await env.PHOTOS.get(row.photo_key);
    if (!obj) return json({ error: 'Photo missing from R2' }, 404);
    const buf = await obj.arrayBuffer();
    const mediaType = obj.httpMetadata?.contentType || 'image/jpeg';
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    photos.push({ mediaType, base64: btoa(bin), part: ALLOWED_PARTS.includes(body?.part) ? body.part : null });
  } else if (Array.isArray(body?.images) && body.images.length > 0) {
    for (const item of body.images.slice(0, 4)) {
      const image = item?.image;
      if (typeof image !== 'string' || !image.startsWith('data:image/')) {
        return json({ error: 'Each images[] item needs { image: "data:image/..." }' }, 400);
      }
      const m = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (!m) return json({ error: 'Malformed image data URL in images[]' }, 400);
      photos.push({
        mediaType: m[1], base64: m[2],
        part: ALLOWED_PARTS.includes(item?.part) ? item.part : null,
      });
    }
  } else {
    const image = body?.image;
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      return json({ error: 'Expected { image }, { images: [...] } or { entry_id, device_id }' }, 400);
    }
    const m = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (!m) return json({ error: 'Malformed image data URL' }, 400);
    photos.push({
      mediaType: m[1], base64: m[2],
      part: ALLOWED_PARTS.includes(body?.part) ? body.part : null,
    });
  }

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'Server not configured: missing ANTHROPIC_API_KEY' }, 500);
  }

  // Resolve Macrostrat (serialised — one quick outbound call before Anthropic)
  const coords = body?.coords;
  const hasCoords = coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng);
  const macrostratCtx = hasCoords ? await fetchBedrockContext(coords.lat, coords.lng) : null;
  const macrostratBlock = formatMacrostratContext(macrostratCtx);
  const testsBlock = formatPhysicalTests(body?.tests);
  const contextBlocks = [macrostratBlock, testsBlock].filter(Boolean);
  const contextText = contextBlocks.length
    ? `\n\n<context>\n${contextBlocks.join('\n\n')}\n</context>`
    : '';

  // Interleave photos with short captions. With multiple photos, tell the
  // model they're all the same specimen from different angles.
  const multi = photos.length > 1;
  const content = [];
  photos.forEach((p, i) => {
    const caption = multi
      ? `Image ${i + 1} of ${photos.length}${p.part ? ` — showing ${PART_LABEL[p.part]}` : ''}.`
      : (p.part ? `This image shows ${PART_LABEL[p.part]}.` : null);
    if (caption) content.push({ type: 'text', text: caption });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: p.mediaType, data: p.base64 },
    });
  });
  content.push({
    type: 'text',
    text: `Identify the subject (rock, mineral, meteorite or fossil).${multi ? ' The images above are all of the SAME specimen — treat them as complementary views and fuse them into one identification.' : ''}${contextText}\n\nReturn JSON only per the schema in the system prompt.`,
  });

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: IDENTIFY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text().catch(() => '');
    console.error('Anthropic error', anthropicRes.status, errText);
    return json({ error: `Claude API error (${anthropicRes.status})`, detail: errText.slice(0, 500) }, 502);
  }

  const payload = await anthropicRes.json();
  const text = payload?.content?.find(c => c.type === 'text')?.text || '';
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error('Could not parse model output as JSON:', text.slice(0, 500));
    return json({ error: 'Model returned non-JSON response', raw: text.slice(0, 500) }, 502);
  }
  if (!parsed || !Array.isArray(parsed.matches)) parsed = { matches: [] };

  // Pass Macrostrat context back so the UI can display it as a first-class
  // "bedrock here" card, separate from the AI's interpretation.
  parsed.macrostrat = macrostratCtx || null;
  return json(parsed, 200);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function serveHtml() {
  return new Response(INDEX_HTML_BYTES, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  });
}

// ── Journal (D1) + Photos (R2) ─────────────────────────────────────
// Device ID is an anonymous client-generated UUID held in localStorage.
// It's the only access key — entries are scoped by device_id, and deletes
// only work when the caller presents the owning device_id.

const DEVICE_ID_RE = /^[a-zA-Z0-9-_]{10,64}$/;
const MAX_PHOTO_BYTES = 600 * 1024;

function validateDeviceId(id) {
  return typeof id === 'string' && DEVICE_ID_RE.test(id);
}

function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!m) return null;
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  return { contentType: m[1], bytes };
}

function extFromContentType(ct) {
  if (ct === 'image/jpeg') return 'jpg';
  if (ct === 'image/png') return 'png';
  if (ct === 'image/webp') return 'webp';
  if (ct === 'image/gif') return 'gif';
  return 'bin';
}

async function journalPost(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const deviceId = body?.device_id;
  if (!validateDeviceId(deviceId)) return json({ error: 'Invalid device_id' }, 400);

  const rock = body?.rock;
  if (!rock || typeof rock !== 'object') return json({ error: 'Missing rock object' }, 400);

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const rockType = typeof rock.rock_type === 'string' ? rock.rock_type : 'other';
  const date = typeof body.date === 'string' ? body.date.slice(0, 40) : '';
  const location = typeof body.location === 'string' ? body.location.slice(0, 120) : '';
  const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : '';
  const lat = Number.isFinite(body?.coords?.lat) ? body.coords.lat : null;
  const lng = Number.isFinite(body?.coords?.lng) ? body.coords.lng : null;

  let photoKey = null;
  if (body.image) {
    const decoded = decodeDataUrl(body.image);
    if (!decoded) return json({ error: 'Malformed image data URL' }, 400);
    if (decoded.bytes.length > MAX_PHOTO_BYTES) {
      return json({ error: `Photo too large (${decoded.bytes.length} bytes, max ${MAX_PHOTO_BYTES})` }, 413);
    }
    photoKey = `photos/${deviceId}/${id}.${extFromContentType(decoded.contentType)}`;
    await env.PHOTOS.put(photoKey, decoded.bytes, {
      httpMetadata: { contentType: decoded.contentType },
    });
  }

  const alternativesJson = Array.isArray(body.alternatives) && body.alternatives.length
    ? JSON.stringify(body.alternatives.slice(0, 5))
    : null;

  // Bedrock context captured at scan time — stored so the detail screen can
  // show "what was beneath you when you found this" even months later.
  const macrostratJson = body.macrostrat && typeof body.macrostrat === 'object'
    ? JSON.stringify(body.macrostrat)
    : null;

  await env.DB.prepare(
    `INSERT INTO journal_entries (id, device_id, rock_json, rock_type, date, location, lat, lng, note, photo_key, created_at, alternatives, macrostrat_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, deviceId, JSON.stringify(rock), rockType, date, location, lat, lng, note, photoKey, createdAt, alternativesJson, macrostratJson
  ).run();

  return json({ id, photo_key: photoKey, created_at: createdAt });
}

async function journalPatch(request, env, id) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const deviceId = body?.device_id;
  if (!validateDeviceId(deviceId)) return json({ error: 'Invalid device_id' }, 400);
  if (!id) return json({ error: 'Missing id' }, 400);

  const row = await env.DB.prepare(
    `SELECT id FROM journal_entries WHERE id = ? AND device_id = ?`
  ).bind(id, deviceId).first();
  if (!row) return json({ error: 'Not found' }, 404);

  const sets = [];
  const values = [];
  if (body.rock && typeof body.rock === 'object') {
    sets.push('rock_json = ?'); values.push(JSON.stringify(body.rock));
    const rt = typeof body.rock.rock_type === 'string' ? body.rock.rock_type : 'other';
    sets.push('rock_type = ?'); values.push(rt);
  }
  if (Array.isArray(body.alternatives)) {
    sets.push('alternatives = ?'); values.push(body.alternatives.length ? JSON.stringify(body.alternatives.slice(0, 5)) : null);
  }
  if (!sets.length) return json({ error: 'No updatable fields' }, 400);

  values.push(id, deviceId);
  await env.DB.prepare(
    `UPDATE journal_entries SET ${sets.join(', ')} WHERE id = ? AND device_id = ?`
  ).bind(...values).run();
  return json({ ok: true });
}

async function journalList(request, env) {
  const url = new URL(request.url);
  const deviceId = url.searchParams.get('device_id');
  if (!validateDeviceId(deviceId)) return json({ error: 'Invalid device_id' }, 400);

  const { results } = await env.DB.prepare(
    `SELECT id, rock_json, rock_type, date, location, lat, lng, note, photo_key, created_at, alternatives, macrostrat_json
     FROM journal_entries WHERE device_id = ? ORDER BY created_at DESC LIMIT 500`
  ).bind(deviceId).all();

  const entries = (results || []).map(r => {
    let rock = null;
    try { rock = JSON.parse(r.rock_json); } catch { rock = null; }
    let alternatives = [];
    if (r.alternatives) {
      try { alternatives = JSON.parse(r.alternatives) || []; } catch { alternatives = []; }
    }
    let macrostrat = null;
    if (r.macrostrat_json) {
      try { macrostrat = JSON.parse(r.macrostrat_json); } catch {}
    }
    return {
      id: r.id,
      rock,
      rock_type: r.rock_type,
      date: r.date || '',
      location: r.location || '',
      coords: (r.lat != null && r.lng != null) ? { lat: r.lat, lng: r.lng } : null,
      note: r.note || '',
      photoUrl: r.photo_key ? `/api/photos/${r.photo_key}` : null,
      createdAt: r.created_at,
      alternatives,
      macrostrat,
    };
  });
  return json({ entries });
}

async function journalDelete(request, env, id) {
  const url = new URL(request.url);
  const deviceId = url.searchParams.get('device_id');
  if (!validateDeviceId(deviceId)) return json({ error: 'Invalid device_id' }, 400);
  if (!id) return json({ error: 'Missing id' }, 400);

  const row = await env.DB.prepare(
    `SELECT photo_key FROM journal_entries WHERE id = ? AND device_id = ?`
  ).bind(id, deviceId).first();
  if (!row) return json({ error: 'Not found' }, 404);

  if (row.photo_key) {
    try { await env.PHOTOS.delete(row.photo_key); } catch (e) { console.error('R2 delete failed', e); }
  }
  await env.DB.prepare(`DELETE FROM journal_entries WHERE id = ? AND device_id = ?`)
    .bind(id, deviceId).run();
  return json({ ok: true });
}

async function servePhoto(request, env, key) {
  if (!key || key.includes('..')) return json({ error: 'Bad key' }, 400);
  const obj = await env.PHOTOS.get(key);
  if (!obj) return json({ error: 'Not found' }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
}

// ── Mindat verify lookup ──────────────────────────────────────────
// Mindat.org is the canonical mineral/rock database. Their REST API needs
// a signup-gated key; we avoid that by scraping the publicly-served HTML
// for the first search hit + its Open Graph meta tags (stable across the
// occasional site redesign, unlike content selectors).
//
// Hit rate is bounded by user intent — only fires when the user taps
// "Verify" on a results card — so we're polite to mindat.org.
// Descriptive modifiers Claude likes to attach to identifications (e.g.
// "Quartzite Pebble", "Weathered Basalt") that Mindat doesn't index. Strip
// these before retrying.
const MINDAT_STRIP_WORDS = /\b(pebble|cobble|boulder|fragment|piece|chunk|specimen|sample|weathered|fresh|water-worn|rounded|tumbled)\b/gi;

function mindatSearchVariants(name) {
  const variants = [name];
  const stripped = name.replace(MINDAT_STRIP_WORDS, '').trim().replace(/\s+/g, ' ');
  if (stripped && stripped !== name) variants.push(stripped);
  // As a last resort, the first word — usually the rock type itself.
  const firstWord = stripped.split(/\s+/)[0];
  if (firstWord && !variants.includes(firstWord)) variants.push(firstWord);
  return variants;
}

async function mindatSearchOne(query) {
  const searchUrl = `https://www.mindat.org/search.php?search=${encodeURIComponent(query)}`;
  const ua = { 'User-Agent': 'Geolyssa/1.0 (+https://geolyssa.clydeford.net)', 'Accept': 'text/html' };
  const searchRes = await fetch(searchUrl, {
    signal: AbortSignal.timeout(5000), headers: ua,
  });
  if (!searchRes.ok) return { search_url: searchUrl };
  const html = await searchRes.text();
  const link = html.match(/href="(\/(?:min|rock)-\d+\.html)"/);
  if (!link) return { search_url: searchUrl };
  const topUrl = `https://www.mindat.org${link[1]}`;

  const detailRes = await fetch(topUrl, {
    signal: AbortSignal.timeout(5000), headers: ua,
  });
  if (!detailRes.ok) return { search_url: searchUrl, top_url: topUrl };
  const detailHtml = await detailRes.text();

  const meta = (attr, val) => new RegExp(
    `<meta[^>]+${attr}=["']${val}["'][^>]+content=["']([^"']+)["']`, 'i'
  );
  const metaRev = (attr, val) => new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${val}["']`, 'i'
  );
  const find = (attr, val) =>
    (detailHtml.match(meta(attr, val)) || detailHtml.match(metaRev(attr, val)))?.[1] || null;

  return {
    search_url: searchUrl,
    top_url: topUrl,
    name: find('property', 'og:title') || query,
    photo_url: find('property', 'og:image'),
    description: find('name', 'description') || find('property', 'og:description'),
  };
}

async function mindatLookup(name) {
  if (!name || typeof name !== 'string') return null;
  const originalSearchUrl = `https://www.mindat.org/search.php?search=${encodeURIComponent(name)}`;
  // Try each variant in order; first one that finds a detail page wins.
  // Misses typically require 2 variants × 1 HTTP call each = fast.
  try {
    for (const variant of mindatSearchVariants(name)) {
      const result = await mindatSearchOne(variant);
      if (result?.top_url) return result;
    }
    // All variants returned only a search URL — give back the original one
    // so the fallback link matches what the user typed.
    return { search_url: originalSearchUrl };
  } catch (e) {
    console.error('Mindat lookup failed', e);
    return { search_url: originalSearchUrl };
  }
}

async function mindat(request) {
  const url = new URL(request.url);
  const name = url.searchParams.get('name');
  if (!name) return json({ error: 'Expected name query param' }, 400);
  const result = await mindatLookup(name);
  return new Response(JSON.stringify(result || null), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // No cache — scraper quirks mean early nulls shouldn't pin for an
      // hour. Worker calls are fast (~200ms), so re-fetching on demand is
      // fine.
      'cache-control': 'no-store',
    },
  });
}

// Standalone bedrock lookup — lets the home screen surface "what's beneath
// you" without waiting for a scan. Cached briefly at the edge.
async function bedrock(request) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get('lat'));
  const lng = parseFloat(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return json({ error: 'Expected lat & lng query params' }, 400);
  }
  const ctx = await fetchBedrockContext(lat, lng);
  return new Response(JSON.stringify(ctx || null), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // No cache — cheap to re-fetch, and we don't want stale nulls from
      // earlier Macrostrat-only responses pinned for an hour.
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/identify') return identify(request, env);
    if (path === '/api/bedrock') return bedrock(request);
    if (path === '/api/mindat') return mindat(request);
    if (path === '/api/health') return json({ ok: true, ts: Date.now() });

    if (path === '/api/journal') {
      if (request.method === 'POST') return journalPost(request, env);
      if (request.method === 'GET') return journalList(request, env);
      return json({ error: 'Method not allowed' }, 405);
    }
    const entryMatch = path.match(/^\/api\/journal\/([a-zA-Z0-9-]+)$/);
    if (entryMatch) {
      if (request.method === 'DELETE') return journalDelete(request, env, entryMatch[1]);
      if (request.method === 'PATCH') return journalPatch(request, env, entryMatch[1]);
    }
    if (path.startsWith('/api/photos/')) {
      return servePhoto(request, env, path.slice('/api/photos/'.length));
    }

    return serveHtml();
  },
};
