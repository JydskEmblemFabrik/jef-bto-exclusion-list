// ONE-OFF DIAGNOSTIC — not part of the daily pipeline. Investigates whether
// the PIM "Product" resource's /productsearch endpoint can identify BTO
// configurator picklist SKUs (the ~910-SKU seed list), now that the
// Lookup List / Lookup List Item API has been confirmed as a dead end
// (every item has empty attributedata `fields: {}`, no sku anywhere).
//
// Chainbox's docs show /productsearch supports filter.rules on arbitrary
// attribute fields (EXISTS / EQ), plus includeCategories/excludeChannels/
// includeFamilies etc. This script probes several hypotheses safely
// (read-only search calls, no writes):
//
//  1. How many products have attributedata.variant-parent set at all
//     (EXISTS)? If this count is in the same ballpark as 910, that's a
//     strong lead that configurator sub-options are modeled as PIM
//     "variants" via this field.
//  2. For a curated sample of KNOWN excluded SKUs (from the v3 seed list),
//     try to look them up via filter {field:'sku', operator:'EQ', value:X}
//     and print their full attributedata/channels/categories — to see
//     directly what, if anything, marks them as configurator sub-options.
//  3. As a baseline, fetch a small unfiltered sample of products (no
//     filter) so we have "ordinary" products' channels/categories/
//     attributedata shape to compare against.
//
// Run manually via the "Diagnose PIM productsearch" workflow (Actions tab).
// This never writes to data/exclusion-list.* — it only logs findings.

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

async function search(body, limit) {
  const url = `${API_ROOT}/productsearch${limit ? `?limit=${limit}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`POST /productsearch failed: ${res.status} ${res.statusText}\n${text.slice(0, 1000)}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    console.error('Response was not valid JSON:', text.slice(0, 1000));
    return null;
  }
}

// Baseline PROBE 3 showed product IDs that look exactly like SKUs (e.g.
// " H-RI-YEP106"), so — since /productsearch's "sku" filter field turned out
// to be unsupported ("sku has no mapping/type and thus cannot be used for
// search") — try GET /product/:productid directly using each known-excluded
// SKU as the id.
async function getProduct(productId) {
  const url = `${API_ROOT}/product/${encodeURIComponent(productId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: authHeader() },
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: text.slice(0, 500) };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: 'parse-error', body: text.slice(0, 500) };
  }
}

// A representative sample of SKUs we KNOW belong in the exclusion list,
// per the manually-audited v3 report (910 SKUs). Deliberately varied:
// plain numeric-looking picks, engraving/print picks, ribbon/band picks,
// and the two previously-validated "exception" SKUs (R4-36 / R8-36) that
// turned out to still belong in the excluded bucket after all.
const KNOWN_EXCLUDED_SKUS = [
  'R4-36',
  'R8-36',
  'DTRIF 999',
  'GRAV LOGO',
  'TRYK MM',
  'BD BÅND',
  'JEF12802',
  'A1-1A',
  'TYPEPO1',
  'XYZ',
];

async function main() {
  console.log(`Using PIM API at ${API_ROOT} (org=${ORG_ID}, pim=${PIM_ID})`);

  console.log('\n=== PROBE 1: how many products have attributedata.variant-parent set? ===');
  const variantParentResult = await search({
    filter: { rules: [{ field: 'variant-parent', operator: 'EXISTS' }], groupingOperator: 'AND' },
  }, 10);
  if (variantParentResult) {
    console.log(`counts: ${JSON.stringify(variantParentResult.counts)}`);
    console.log('Sample records:', JSON.stringify(variantParentResult.data, null, 2).slice(0, 3000));
  }

  console.log('\n=== PROBE 2: look up known-excluded SKUs by filter field "sku" EQ (expected to fail — kept for the record) ===');
  {
    const sku = KNOWN_EXCLUDED_SKUS[0];
    const result = await search({
      filter: { rules: [{ field: 'sku', operator: 'EQ', value: sku }], groupingOperator: 'AND' },
    }, 5);
    if (result) {
      console.log(`--- SKU "${sku}" -> counts=${JSON.stringify(result.counts)} ---`);
      console.log(JSON.stringify(result.data, null, 2));
    }
  }

  console.log('\n=== PROBE 4: GET /product/:productid directly, using each known-excluded SKU as the id ===');
  for (const sku of KNOWN_EXCLUDED_SKUS) {
    const result = await getProduct(sku);
    if (result.ok) {
      console.log(`--- SKU "${sku}" -> FOUND ---`);
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      console.log(`--- SKU "${sku}" -> NOT FOUND (status=${result.status}) ${result.body} ---`);
    }
  }

  console.log('\n=== PROBE 3: baseline — small unfiltered sample of products ===');
  const baseline = await search({}, 5);
  if (baseline) {
    console.log(`counts: ${JSON.stringify(baseline.counts)}`);
    console.log('Sample records:', JSON.stringify(baseline.data, null, 2).slice(0, 3000));
  }

  console.log('\nDone. This is a read-only diagnostic; no files were written.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
