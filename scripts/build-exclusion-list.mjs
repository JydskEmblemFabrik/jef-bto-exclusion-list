// Rebuilds the Meta/Google content_id exclusion list using Chainbox's
// OFFICIAL, DOCUMENTED PIM partner API (Basic Auth):
//   https://documentation.chainbox.dk/chainbox-api/pim-api/lookuplist/
//   https://documentation.chainbox.dk/chainbox-api/pim-api/lookuplistitem/
//
// STATUS (2026-09-10, run #1): the "Lookup List" / "Lookup List Item" API
// turned out NOT to be BTO's configurator picklists. The very first live run
// found 19 lookup lists (variant, farve, hoejde, bagmontering, diameter, ...)
// and 1824 lookup list items, but ZERO of them carry a SKU under any of the
// field names this script checks. Those lookup lists look like generic PIM
// attribute/variant dictionaries (colour names, height values, mounting
// types, diameters used for building product *variants* inside PIM itself),
// not BTO's "which SKU does this configurator choice map to" data.
//
// This script is being kept, with a hard safety floor (see MIN_SKUS below)
// and a debug dump of raw item shapes, so we can either (a) find the real
// field the SKU lives under, if this data does relate to BTO after all, or
// (b) conclude this PIM endpoint is the wrong data source and go back to
// Chainbox for BTO-management's own API instead. Either way, this script
// must NEVER silently overwrite a known-good exclusion list with a
// low/zero-confidence result — that's what MIN_SKUS enforces.
//
// Required GitHub Actions secrets (see SETUP.md):
//   PIM_API_BASE_URL   e.g. https://pim-api.service.chainbox.io
//   PIM_ORG_ID         e.g. jef
//   PIM_PIM_ID         e.g. pim
//   PIM_API_USERNAME   the API user (looks like a UUID)
//   PIM_API_PASSWORD   its password
//
// Methodology (v3, confirmed with JEF): a SKU is excluded if it appears ONLY
// as a BTO configurator picklist choice — regardless of its own PIM status
// (ehandel, category relation, itemtype, etc. all turned out to be
// unreliable signals for "is this independently matchable in the Meta/Google
// feed" — see the v3 report). So the only real signal we need per lookup
// list item is: does it carry a SKU at all. If it does, it's a
// configurator-style pick (color, engraving option, ribbon, ...), and it
// gets excluded, exactly like every SKU manually checked this way so far.

import fs from 'node:fs/promises';

const BASE_URL = (process.env.PIM_API_BASE_URL || 'https://pim-api.service.chainbox.io').replace(/\/+$/, '');
const ORG_ID = process.env.PIM_ORG_ID || 'jef';
const PIM_ID = process.env.PIM_PIM_ID || 'pim';
const USERNAME = process.env.PIM_API_USERNAME;
const PASSWORD = process.env.PIM_API_PASSWORD;

// Hard floor: never trust (and never write/commit) a result with fewer than
// this many SKUs. The manual v3 audit found ~910; 0 or a handful is a clear
// sign this data source or field-mapping is wrong, not that BTO suddenly has
// almost no configurator picks. Failing loudly (non-zero exit, no file
// writes) means the "commit if changed" step in the workflow has nothing new
// to commit, so today's good data (committed manually or by a prior good
// run) stays live and safe.
const MIN_SKUS = 500;

if (!USERNAME || !PASSWORD) {
  console.error('Missing PIM_API_USERNAME / PIM_API_PASSWORD secrets.');
  process.exit(1);
}

const API_ROOT = `${BASE_URL}/${ORG_ID}/${PIM_ID}/api/v0.1`;

function authHeader() {
  const token = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}

async function getJson(path) {
  const url = `${API_ROOT}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
  }
  return res.json();
}

// The docs describe "Get All Lookup Lists" / "Get All Lookup List Items" as
// returning an object keyed by code, not a bare array — handle both shapes
// defensively rather than assuming.
function asRecords(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    if (Array.isArray(json.data)) return json.data;
    // "keyed by code" shape
    const values = Object.values(json.data ?? json);
    if (values.every((v) => v && typeof v === 'object')) return values;
  }
  throw new Error('Unexpected response shape — inspect and update asRecords(). First 500 chars: ' + JSON.stringify(json).slice(0, 500));
}

// SKU could plausibly live under a few different keys depending on how the
// underlying "fields" collection was configured — check the obvious ones,
// plus (new) any key anywhere in item.fields whose name contains "sku"
// case-insensitively, in case the real field has a different exact name
// (e.g. a custom fields key like "artikelnummer" mapped internally).
function extractSku(item) {
  const candidates = [
    item.sku,
    item.fields?.sku,
    item.fields?.SKU,
    item.fields?.Sku,
    item.data?.sku,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  if (item.fields && typeof item.fields === 'object') {
    for (const [key, value] of Object.entries(item.fields)) {
      if (/sku/i.test(key) && typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }
  return null;
}

function extractLabel(item) {
  return item.label || item.fields?.label || '';
}

async function main() {
  console.log(`Using PIM API at ${API_ROOT} (org=${ORG_ID}, pim=${PIM_ID})`);

  console.log('Fetching all lookup lists (for logging/sanity-check only)...');
  const listsRaw = await getJson('/lookuplist/lookuplists');
  const lists = asRecords(listsRaw);
  console.log(`  -> ${lists.length} lookup lists total`);
  console.log('  All codes/labels:', lists.map((l) => `${l.code} (${l.label})`).join(', '));

  console.log('Fetching all lookup list items...');
  const itemsRaw = await getJson('/lookuplistitem/lookuplistitems');
  const items = asRecords(itemsRaw);
  console.log(`  -> ${items.length} lookup list items total`);

  // --- DEBUG DUMP --------------------------------------------------------
  // Print the raw shape of a handful of items so we can see the *actual*
  // field names this API uses, rather than guessing. This is intentionally
  // verbose and temporary — safe to trim once we've confirmed (or ruled out)
  // where SKU data lives.
  console.log('--- DEBUG: raw shape of first 3 lookup list items ---');
  console.log(JSON.stringify(items.slice(0, 3), null, 2));

  const allFieldKeys = new Set();
  for (const item of items) {
    for (const key of Object.keys(item)) allFieldKeys.add(key);
    if (item.fields && typeof item.fields === 'object') {
      for (const key of Object.keys(item.fields)) allFieldKeys.add('fields.' + key);
    }
  }
  console.log('--- DEBUG: union of all keys seen across all items ---');
  console.log([...allFieldKeys].sort().join(', '));
  // ------------------------------------------------------------------------

  const skuToLabels = new Map();
  let itemsWithSku = 0;
  for (const item of items) {
    const sku = extractSku(item);
    if (!sku) continue;
    itemsWithSku++;
    const label = extractLabel(item);
    if (!skuToLabels.has(sku)) skuToLabels.set(sku, new Set());
    if (label) skuToLabels.get(sku).add(label);
  }
  console.log(`  -> ${itemsWithSku} items carry a SKU (these are the configurator-style picks we exclude)`);

  const skus = [...skuToLabels.keys()].sort();
  console.log(`Computed ${skus.length} distinct SKUs to exclude.`);

  // Sanity-check against the manually-verified seed list (v3 report, 910
  // SKUs) so every run tells us plainly whether Lookup List data really is
  // equivalent to BTO's picklists, or whether something's off.
  let overlapPctOfSeed = 'n/a';
  try {
    const seed = JSON.parse(await fs.readFile('data/exclusion-list.json', 'utf8'));
    const seedSet = new Set(seed.skus || []);
    const newSet = new Set(skus);
    const overlap = [...newSet].filter((s) => seedSet.has(s)).length;
    overlapPctOfSeed = seed.skus?.length ? ((overlap / seed.skus.length) * 100).toFixed(1) : 'n/a';
    const overlapPctOfNew = skus.length ? ((overlap / skus.length) * 100).toFixed(1) : 'n/a';
    console.log(`Sanity check vs. previous list (${seed.skus?.length ?? 0} SKUs): ${overlap} SKUs in common ` +
      `(${overlapPctOfSeed}% of the previous list, ${overlapPctOfNew}% of this new one).`);
  } catch {
    console.log('(No previous data/exclusion-list.json to compare against — skipping sanity check.)');
  }

  // --- SAFETY FLOOR --------------------------------------------------------
  // Never write (and therefore never commit) a result this low-confidence.
  // Exiting non-zero here means the workflow job fails loudly and visibly
  // (so it shows up as a red X in Actions / GitHub notifications), and the
  // "commit if changed" step never runs — today's already-committed data
  // stays exactly as it was.
  if (skus.length < MIN_SKUS) {
    console.error(
      `REFUSING TO WRITE: only ${skus.length} SKUs found (minimum trusted floor is ${MIN_SKUS}; ` +
      `the manual v3 audit found ~910). This means the Lookup List API is very likely NOT the same ` +
      `data as BTO's configurator picklists, or the SKU field lives under a key this script doesn't ` +
      `check yet — see the DEBUG dump above for the real field names, then either fix extractSku() ` +
      `or fall back to requesting BTO-management's own API from Chainbox. Leaving the previously ` +
      `committed data/exclusion-list.* files untouched.`
    );
    process.exit(1);
  }
  // --------------------------------------------------------------------------

  const generated_at = new Date().toISOString();

  await fs.mkdir('data', { recursive: true });

  await fs.writeFile(
    'data/exclusion-list.json',
    JSON.stringify({ generated_at, count: skus.length, skus }, null, 2)
  );

  await fs.writeFile('data/exclusion-list.txt', skus.join('\n') + '\n');

  const escaped = skus.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  await fs.writeFile('data/exclusion-list.regex.txt', `^(${escaped.join('|')})$`);

  console.log(`Done. Wrote data/exclusion-list.{json,txt,regex.txt} at ${generated_at}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
