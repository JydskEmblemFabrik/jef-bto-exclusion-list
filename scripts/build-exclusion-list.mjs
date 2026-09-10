// Rebuilds the Meta/Google content_id exclusion list using Chainbox's
// OFFICIAL, DOCUMENTED PIM partner API (Basic Auth):
//   https://documentation.chainbox.dk/chainbox-api/pim-api/lookuplist/
//   https://documentation.chainbox.dk/chainbox-api/pim-api/lookuplistitem/
//
// Why this API, and not BTO-management's internal one: JEF already has a
// working, properly-provisioned API user for PIM (issued by Chainbox for an
// earlier project) — no new request to Chainbox needed. And structurally,
// BTO's configurator "picklists" and "picklist items" line up almost exactly
// with PIM's generic "Lookup List" / "Lookup List Item" resources (same
// code / label / sortorder shape, items reference their parent list). This
// script assumes that's the same underlying data; the very first run's log
// output includes a sanity check against the known-good manual list (910
// SKUs, see data/exclusion-list.json's seed data) so that assumption gets
// confirmed or refuted immediately, in plain sight, rather than silently.
//
// This script is READ-ONLY by design (GET requests only), even though the
// credential JEF has also carries write access — no endpoint here can
// modify PIM data.
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
// underlying "fields" collection was configured — check the obvious ones.
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
  console.log('  Sample codes/labels:', lists.slice(0, 5).map((l) => `${l.code} (${l.label})`).join(', '));

  console.log('Fetching all lookup list items...');
  const itemsRaw = await getJson('/lookuplistitem/lookuplistitems');
  const items = asRecords(itemsRaw);
  console.log(`  -> ${items.length} lookup list items total`);

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
  // SKUs) so the very first run tells us plainly whether Lookup List data
  // really is equivalent to BTO's picklists, or whether something's off.
  try {
    const seed = JSON.parse(await fs.readFile('data/exclusion-list.json', 'utf8'));
    const seedSet = new Set(seed.skus || []);
    const newSet = new Set(skus);
    const overlap = [...newSet].filter((s) => seedSet.has(s)).length;
    const overlapPctOfSeed = seed.skus?.length ? ((overlap / seed.skus.length) * 100).toFixed(1) : 'n/a';
    const overlapPctOfNew = skus.length ? ((overlap / skus.length) * 100).toFixed(1) : 'n/a';
    console.log(`Sanity check vs. previous list (${seed.skus?.length ?? 0} SKUs): ${overlap} SKUs in common ` +
      `(${overlapPctOfSeed}% of the previous list, ${overlapPctOfNew}% of this new one).`);
    if (Number(overlapPctOfSeed) < 50) {
      console.warn('WARNING: overlap is low — before trusting this list, manually compare a few SKUs ' +
        'against the known-good v3 list (e.g. R1-22, DTRIF 999) to confirm the Lookup List API really is BTO\'s picklist data.');
    }
  } catch {
    console.log('(No previous data/exclusion-list.json to compare against — skipping sanity check.)');
  }

  if (skus.length < 500) {
    console.warn(
      `WARNING: this is far fewer than the ~910 found in the manual audit. ` +
      `Double-check PIM_API_USERNAME / PIM_API_PASSWORD are valid, and that ` +
      `Lookup List Items really do carry the same SKUs as BTO's picklist items, before trusting this.`
    );
  }

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
