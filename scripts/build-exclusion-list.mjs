// Rebuilds the Meta/Google/Bing content_id exclusion list from Chainbox's
// PIM Product resource, filtering on the custom attribute
// `bto-picklist-exclude` (a Boolean field created manually in the PIM admin
// UI: Define > Attributes > Code "bto-picklist-exclude", Set "Webshop
// Configuration", not ERP-mapped).
//
// HISTORY:
//  - v1/v2 tried Chainbox's "Lookup List" / "Lookup List Item" API — dead
//    end, every item's `fields` is always empty (no SKU data at all).
//  - v3 (this version) uses productsearch filtered on the new custom field,
//    which every currently-known excluded SKU was bulk-tagged with via
//    scripts/bulk-tag-skus.mjs (881/910 tagged; 29 could not be tagged
//    because no PIM product exists under that exact id anymore — see
//    MANUAL_ADDITIONS below, which keeps them excluded regardless).
//
// Required GitHub Actions secrets (see SETUP.md):
//   PIM_API_BASE_URL, PIM_ORG_ID, PIM_PIM_ID, PIM_API_USERNAME, PIM_API_PASSWORD

import fs from 'node:fs/promises';

const BASE_URL = (process.env.PIM_API_BASE_URL || 'https://pim-api.service.chainbox.io').replace(/\/+$/, '');
const ORG_ID = process.env.PIM_ORG_ID || 'jef';
const PIM_ID = process.env.PIM_PIM_ID || 'pim';
const USERNAME = process.env.PIM_API_USERNAME;
const PASSWORD = process.env.PIM_API_PASSWORD;

// Hard floor: never trust (and never write/commit) a result with fewer than
// this many SKUs. The manual v3 audit found ~910; the bulk-tag run tagged
// 881 of those directly in PIM. 0 or a handful here means the field name,
// filter, or credentials are wrong — not that BTO suddenly has almost no
// configurator picks.
const MIN_SKUS = 500;

// SKUs from the original manually-audited exclusion list that, as of
// 2026-09-10, no longer resolve to any PIM product at all (GET /product/:id
// -> 404) and so could NOT be tagged with the bto-picklist-exclude
// attribute — there is nothing in PIM to attach the flag to. They are kept
// here explicitly so they stay excluded from Meta/Google/Bing matching
// (better a stale exclusion than accidentally letting a bad content_id back
// into a feed). If a future refresh finds one of these SKUs exists again in
// PIM, tag it there via the PIM UI/API and it will then be picked up
// automatically by the productsearch query below — feel free to remove it
// from this list at that point.
const MANUAL_ADDITIONS = [
  '34-36', '8000 Luk', '8000-Snor', '8030', 'A1-4B', 'A2-2022',
  'BDDK Bånd', 'BTDK 8000', 'DBOF Bånd', 'DBOF NY Bånd', 'DBOU Bånd',
  'DFU 999', 'DTHK Bånd', 'GYM Bånd', 'GYM32 LABEL', 'GYM42 LABEL',
  'GYM52 LABEL', 'IPA999', 'R10-26', 'R10-29', 'R10-3', 'R11-24',
  'R12-6', 'R2-15', 'R6-3', 'R9-2', 'TT 190 1 FV-bag', 'Tryk21', 'xyz',
];

if (!USERNAME || !PASSWORD) {
  console.error('Missing PIM_API_USERNAME / PIM_API_PASSWORD secrets.');
  process.exit(1);
}

const API_ROOT = `${BASE_URL}/${ORG_ID}/${PIM_ID}/api/v0.1`;

function authHeader() {
  const token = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}

async function searchPage(lastoffsetid) {
  const params = new URLSearchParams({ limit: '250' });
  if (lastoffsetid) params.set('lastoffsetid', lastoffsetid);
  const url = `${API_ROOT}/productsearch?${params.toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: {
        rules: [{ field: 'bto-picklist-exclude', operator: 'EQ', value: true }],
        groupingOperator: 'AND',
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST /productsearch failed: ${res.status} ${res.statusText}\n${text.slice(0, 1000)}`);
  }
  return JSON.parse(text);
}

async function main() {
  console.log(`Using PIM API at ${API_ROOT} (org=${ORG_ID}, pim=${PIM_ID})`);
  console.log('Querying productsearch for products with bto-picklist-exclude = true ...');

  const productIds = [];
  let lastoffsetid;
  let page = 0;
  while (true) {
    page++;
    const result = await searchPage(lastoffsetid);
    const ids = Object.keys(result.data || {});
    productIds.push(...ids);
    console.log(`  page ${page}: ${ids.length} products (running total: ${productIds.length}; counts=${JSON.stringify(result.counts)})`);
    if (!result.nextOffset || ids.length === 0) break;
    lastoffsetid = result.nextOffset;
    if (page > 50) {
      console.error('Aborting after 50 pages — something looks wrong (unbounded pagination).');
      break;
    }
  }

  // The product id IS the SKU for this catalog (confirmed via GET
  // /product/:sku working directly with the SKU string).
  const fromPim = [...new Set(productIds)];
  console.log(`\nFound ${fromPim.length} distinct SKUs tagged bto-picklist-exclude=true in PIM.`);

  const skus = [...new Set([...fromPim, ...MANUAL_ADDITIONS])].sort();
  console.log(`Combined with ${MANUAL_ADDITIONS.length} manually-kept SKU(s) not currently in PIM: ${skus.length} total distinct SKUs.`);

  // Sanity-check against the previous list so every run tells us plainly if
  // something has drifted a lot.
  try {
    const prev = JSON.parse(await fs.readFile('data/exclusion-list.json', 'utf8'));
    const prevSet = new Set(prev.skus || []);
    const newSet = new Set(skus);
    const overlap = [...newSet].filter((s) => prevSet.has(s)).length;
    console.log(`Sanity check vs. previous list (${prev.skus?.length ?? 0} SKUs): ${overlap} SKUs in common.`);
  } catch {
    console.log('(No previous data/exclusion-list.json to compare against — skipping sanity check.)');
  }

  if (skus.length < MIN_SKUS) {
    console.error(
      `REFUSING TO WRITE: only ${skus.length} SKUs found (minimum trusted floor is ${MIN_SKUS}). This means the ` +
      `bto-picklist-exclude filter, credentials, or field name may be wrong. Leaving the previously committed ` +
      `data/exclusion-list.* files untouched.`
    );
    process.exit(1);
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

  console.log(`\nDone. Wrote data/exclusion-list.{json,txt,regex.txt} at ${generated_at} (${skus.length} SKUs).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
