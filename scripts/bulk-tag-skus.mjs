// ONE-TIME SCRIPT — not part of the daily pipeline.
//
// Tags every currently-known excluded SKU (from data/exclusion-list.json,
// the manually-audited v3 seed list, 910 SKUs) with a new custom PIM
// attribute `bto-picklist-exclude: true`.
//
// IMPORTANT (found 2026-09-10, run #2): the batched "Patch Multiple"
// endpoint (PATCH /products, body keyed by product id) is ALL-OR-NOTHING
// per batch — if even one product id in a batch of 50 doesn't exist in
// PIM, the ENTIRE batch is rejected with 400 "Product X not found. Only
// existing products can be updated", and none of the other (valid) SKUs
// in that batch get tagged either. A first run this way only tagged
// 250/910 SKUs, purely because ~66 batches contained at least one
// not-found SKU.
//
// Fix: tag SKUs ONE AT A TIME via PATCH /product/:id (Patch Single). This
// is slower but isolates failures to the specific SKU that doesn't exist —
// every other SKU still gets tagged. A small concurrency pool keeps this
// fast without hammering the API.
//
// The attribute itself was created via the PIM admin UI (Define > Attributes
// > Create attribute): Label "BTO Picklist Exclude", Code
// "bto-picklist-exclude", Datatype Boolean, Set "Webshop Configuration",
// Read only: No, ERP mapping: none (so it stays freely writable via API).
//
// Usage:
//   node scripts/bulk-tag-skus.mjs                 # tag all SKUs from data/exclusion-list.json
//   node scripts/bulk-tag-skus.mjs --limit 5        # only tag the first 5 (smoke test)
//   node scripts/bulk-tag-skus.mjs --dry-run        # log what would be sent, no writes
//
// Required env vars (same as the rest of this project):
//   PIM_API_BASE_URL, PIM_ORG_ID, PIM_PIM_ID, PIM_API_USERNAME, PIM_API_PASSWORD

import fs from 'node:fs/promises';

const BASE_URL = (process.env.PIM_API_BASE_URL || 'https://pim-api.service.chainbox.io').replace(/\/+$/, '');
const ORG_ID = process.env.PIM_ORG_ID || 'jef';
const PIM_ID = process.env.PIM_PIM_ID || 'pim';
const USERNAME = process.env.PIM_API_USERNAME;
const PASSWORD = process.env.PIM_API_PASSWORD;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;

const CONCURRENCY = 8; // small pool of parallel single-product PATCH requests

if (!USERNAME || !PASSWORD) {
  console.error('Missing PIM_API_USERNAME / PIM_API_PASSWORD env vars.');
  process.exit(1);
}

const API_ROOT = `${BASE_URL}/${ORG_ID}/${PIM_ID}/api/v0.1`;

function authHeader() {
  const token = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}

async function patchProduct(sku) {
  if (dryRun) {
    return { sku, ok: true, status: 'dry-run' };
  }
  const res = await fetch(`${API_ROOT}/product/${encodeURIComponent(sku)}`, {
    method: 'PATCH',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ attributedata: { 'bto-picklist-exclude': true } }),
  });
  const text = await res.text();
  if (!res.ok) {
    return { sku, ok: false, status: res.status, body: text.slice(0, 300) };
  }
  return { sku, ok: true, status: res.status };
}

async function getProduct(sku) {
  const res = await fetch(`${API_ROOT}/product/${encodeURIComponent(sku)}`, {
    method: 'GET',
    headers: { Authorization: authHeader() },
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, body: text.slice(0, 300) };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: 'parse-error', body: text.slice(0, 300) };
  }
}

// Simple fixed-size concurrency pool.
async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, runOne);
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log(`Using PIM API at ${API_ROOT} (org=${ORG_ID}, pim=${PIM_ID})${dryRun ? ' [DRY RUN]' : ''}`);

  const seed = JSON.parse(await fs.readFile('data/exclusion-list.json', 'utf8'));
  let skus = seed.skus;
  console.log(`Loaded ${skus.length} SKUs from data/exclusion-list.json (generated_at=${seed.generated_at}).`);

  if (limit) {
    skus = skus.slice(0, limit);
    console.log(`--limit ${limit} passed: only tagging the first ${skus.length} SKUs.`);
  }

  console.log(`Tagging ${skus.length} SKUs one at a time (concurrency=${CONCURRENCY}). This isolates failures to the specific SKU — one missing product no longer blocks the rest.`);

  let done = 0;
  const results = await runPool(skus, async (sku) => {
    const r = await patchProduct(sku);
    done++;
    if (done % 100 === 0 || done === skus.length) {
      console.log(`  progress: ${done}/${skus.length}`);
    }
    return r;
  }, CONCURRENCY);

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log(`\nDone tagging: ${succeeded.length} succeeded, ${failed.length} failed.`);

  if (failed.length) {
    console.log(`\n${failed.length} SKU(s) could not be tagged (most likely: no PIM product exists under this exact id anymore) —`);
    console.log('these need a human look (renamed/discontinued product? typo in the seed list?):');
    for (const f of failed) {
      console.log(`  ${f.sku}: status ${f.status} — ${f.body || ''}`.trim());
    }
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile(
      'data/bulk-tag-not-found.json',
      JSON.stringify({ generated_at: new Date().toISOString(), count: failed.length, skus: failed.map((f) => f.sku) }, null, 2)
    );
    console.log(`\nWrote data/bulk-tag-not-found.json with the ${failed.length} SKU(s) that could not be tagged.`);
  }

  if (dryRun) {
    console.log('\n[dry-run] Skipping spot-check verification.');
    return;
  }

  // Spot-check a handful of the SKUs that DID succeed.
  const sampleSize = Math.min(5, succeeded.length);
  const sample = succeeded.slice(0, sampleSize).map((r) => r.sku);
  console.log(`\nSpot-checking ${sample.length} successfully-tagged SKUs via GET /product/:id ...`);
  for (const sku of sample) {
    const result = await getProduct(sku);
    if (result.ok) {
      const flag = result.data?.attributedata?.['bto-picklist-exclude'];
      console.log(`  ${sku}: bto-picklist-exclude = ${JSON.stringify(flag)}`);
    } else {
      console.log(`  ${sku}: could not verify (status ${result.status})`);
    }
  }

  // Fail the job only if NOTHING could be tagged (a real problem), not just
  // because some already-gone SKUs 404'd — that's expected and handled above.
  if (succeeded.length === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
