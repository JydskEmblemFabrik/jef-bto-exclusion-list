// Rebuilds the Meta/Google/Bing content_id exclusion list from Chainbox's
// PIM Product resource.
//
// HISTORY:
//  - v1/v2 tried Chainbox's "Lookup List" / "Lookup List Item" API — dead
//    end, every item's `fields` is always empty (no SKU data at all).
//  - v3 used productsearch filtered on the custom attribute
//    `bto-picklist-exclude` (a Boolean field manually tagged onto 881/910
//    known-bad SKUs via scripts/bulk-tag-skus.mjs). Retired 2026-09-26:
//    confirmed both incomplete (newly created BTO resource SKUs never get
//    tagged, e.g. '9006', 'PANT-1', 'PORTO', 'START', 'TRYK21' were never
//    flagged and kept leaking through) AND wrong in the other direction
//    (real, independently sellable products used as BTO picklist choices —
//    e.g. the "A2-100/A2-129/A2-138" activity-badge picks — were ALSO
//    tagged true at some point, so genuine conversions for them were being
//    suppressed too). A manually-maintained flag on ~95k products can't
//    keep up with new BTO configurations being added continuously.
//  - v4 first attempt used `categories` empty as the sole signal, but a
//    2026-09-26 full-catalog test run found this WAY too broad (74,952 of
//    95,471 products, ~78%): every individual colour/size child of every
//    ordinary garment (e.g. 'ID0313001014' "PRO Wear T-shirt dame 4XL",
//    'PFC-K04042HH' a children's polo) ALSO has empty `categories` — only
//    the parent/family record carries the category, since customers browse
//    the parent's page and pick a variant there. Excluding those would have
//    silently hidden real conversions for a huge share of the catalogue,
//    which is a much worse outcome than the original leaking-content_id
//    problem this whole list exists to fix.
//  - v4 (this version) adds the one field that reliably tells the two apart:
//    `variant-parent`. A real garment/product variant always carries it
//    (pointing at its family, e.g. 'ID0313', 'PFC-K0404'); true BTO/
//    configurator/resource lines never do (checked: TYPE4I, XYZ, 40000-1/2/3,
//    9006, PANT-1, OPSTART200, PORTO, FRAGTMFYN025, START, TRYK21, the
//    'CL..._po_...'/'G..._po_...' decoration-technique lines, and the R#-#
//    ribbon/band picklist codes used inside "byg selv" medal configurators —
//    none of them have it). So a product is excluded when:
//      1) `categories` is empty AND `variant-parent` is NOT set -> not an
//         independently browsable/catalogable product, and not a real
//         variant child of one either (true for every BTO resource/fee/
//         freight/decoration/ribbon line checked), OR
//      2) `restrict-by-customer-id` (or legacy `begraens-til-kundenummer-tm`)
//         is non-empty -> "Egne varer": a real, properly categorized
//         product, but locked to one specific debtor number, so a dynamic
//         ad for it would never make sense to anyone else seeing it.
//    This is self-maintaining: a brand new BTO configurator SKU is excluded
//    the moment it exists in PIM without a category or a variant family,
//    with nobody needing to remember to tag it — and a brand new t-shirt
//    colour is correctly kept the moment it's created with a variant-parent,
//    even before anyone gets around to reviewing it.
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
// this many SKUs. The old flag-based v3 found ~910 tagged SKUs; a full
// catalog scan finds every uncategorized/customer-locked product, which is
// a superset, so this floor should if anything be crossed comfortably. 0 or
// a handful here means the field names, pagination, or credentials are
// wrong — not that BTO suddenly has almost no configurator picks.
const MIN_SKUS = 500;

// SKUs that were confirmed excluded under v3 but, as of 2026-09-10, no
// longer resolve to any PIM product at all (GET /product/:id -> 404) —
// there is nothing in PIM for the new full-catalog scan to find, so they'd
// silently fall out of the list even though a stale BTO picklist item
// somewhere might still submit one of these SKUs as a content_id. Kept
// explicitly so they stay excluded (better a stale exclusion than
// accidentally letting a bad content_id back into a feed). If a SKU here
// turns out to exist in PIM again, the scan below will find it on its own
// merits (empty categories) — feel free to remove it from this list then.
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

function isRestrictedToCustomer(attrs) {
  const a = attrs?.['restrict-by-customer-id'];
  const b = attrs?.['begraens-til-kundenummer-tm'];
  const nonEmpty = (v) => Array.isArray(v) ? v.length > 0 : !!v;
  return nonEmpty(a) || nonEmpty(b);
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
    // No filter: this has to see every product to correctly classify each
    // one, not just the ones someone already suspected were bad.
    body: JSON.stringify({}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST /productsearch failed: ${res.status} ${res.statusText}\n${text.slice(0, 1000)}`);
  }
  return JSON.parse(text);
}

async function main() {
  console.log(`Using PIM API at ${API_ROOT} (org=${ORG_ID}, pim=${PIM_ID})`);
  console.log('Scanning full PIM catalog, classifying every product by categories[] and restrict-by-customer-id ...');

  const excludedIds = [];
  let totalScanned = 0;
  let lastoffsetid;
  let page = 0;
  while (true) {
    page++;
    const result = await searchPage(lastoffsetid);
    const entries = Object.entries(result.data || {});
    for (const [id, product] of entries) {
      totalScanned++;
      const categories = product.categories || [];
      const attrs = product.attributedata || {};
      const hasVariantParent = !!attrs['variant-parent'];
      const uncatalogued = categories.length === 0 && !hasVariantParent;
      if (uncatalogued || isRestrictedToCustomer(attrs)) {
        excludedIds.push(id);
      }
    }
    if (page % 20 === 0 || entries.length === 0) {
      console.log(`  page ${page}: scanned ${totalScanned} total so far, ${excludedIds.length} excluded so far (counts=${JSON.stringify(result.counts)})`);
    }
    if (!result.nextOffset || entries.length === 0) break;
    lastoffsetid = result.nextOffset;
    if (page > 600) {
      console.error('Aborting after 600 pages — something looks wrong (unbounded pagination).');
      break;
    }
  }

  console.log(`\nScanned ${totalScanned} products total. Found ${excludedIds.length} to exclude (empty categories, or customer-restricted).`);

  const fromPim = [...new Set(excludedIds)];
  const skus = [...new Set([...fromPim, ...MANUAL_ADDITIONS])].sort();
  console.log(`Combined with ${MANUAL_ADDITIONS.length} manually-kept SKU(s) no longer present in PIM: ${skus.length} total distinct SKUs.`);

  // Sanity-check against the previous list so every run tells us plainly if
  // something has drifted a lot.
  try {
    const prev = JSON.parse(await fs.readFile('data/exclusion-list.json', 'utf8'));
    const prevSet = new Set(prev.skus || []);
    const newSet = new Set(skus);
    const overlap = [...newSet].filter((s) => prevSet.has(s)).length;
    const added = [...newSet].filter((s) => !prevSet.has(s));
    const removed = [...prevSet].filter((s) => !newSet.has(s));
    console.log(`Sanity check vs. previous list (${prev.skus?.length ?? 0} SKUs): ${overlap} SKUs in common, ${added.length} newly added, ${removed.length} removed.`);
    if (removed.length > 0) {
      console.log(`  Removed (no longer excluded — should now have real conversions tracked): ${removed.slice(0, 50).join(', ')}${removed.length > 50 ? ', ...' : ''}`);
    }
  } catch {
    console.log('(No previous data/exclusion-list.json to compare against — skipping sanity check.)');
  }

  if (skus.length < MIN_SKUS) {
    console.error(
      `REFUSING TO WRITE: only ${skus.length} SKUs found (minimum trusted floor is ${MIN_SKUS}). This means the ` +
      `categories/restrict-by-customer-id fields, credentials, or pagination may be wrong. Leaving the previously ` +
      `committed data/exclusion-list.* files untouched.`
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
