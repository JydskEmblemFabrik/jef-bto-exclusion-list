// ONE-TIME SCRIPT — not part of the daily pipeline.
//
// Tags every currently-known excluded SKU (from data/exclusion-list.json,
// the manually-audited v3 seed list, 910 SKUs) with a new custom PIM
// attribute `bto-picklist-exclude: true`, using Chainbox's documented
// "Patch Multiple" endpoint (PATCH /products, body keyed by product id).
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

const BATCH_SIZE = 50; // conservative — no documented cap, but keep batches small and safe
const DELAY_MS = 300; // small pause between batches

if (!USERNAME || !PASSWORD) {
  console.error('Missing PIM_API_USERNAME / PIM_API_PASSWORD env vars.');
  process.exit(1);
}

const API_ROOT = `${BASE_URL}/${ORG_ID}/${PIM_ID}/api/v0.1`;

function authHeader() {
  const token = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function patchProducts(skus) {
  const body = {};
  for (const sku of skus) {
    body[sku] = { attributedata: { 'bto-picklist-exclude': true } };
  }

  if (dryRun) {
    console.log(`[dry-run] Would PATCH /products for ${skus.length} SKUs: ${skus.join(', ')}`);
    return { ok: true, status: 'dry-run' };
  }

  const res = await fetch(`${API_ROOT}/products`, {
    method: 'PATCH',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: text.slice(0, 1000) };
  }
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  return { ok: true, status: res.status, data: parsed };
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

async function main() {
  console.log(`Using PIM API at ${API_ROOT} (org=${ORG_ID}, pim=${PIM_ID})${dryRun ? ' [DRY RUN]' : ''}`);

  const seed = JSON.parse(await fs.readFile('data/exclusion-list.json', 'utf8'));
  let skus = seed.skus;
  console.log(`Loaded ${skus.length} SKUs from data/exclusion-list.json (generated_at=${seed.generated_at}).`);

  if (limit) {
    skus = skus.slice(0, limit);
    console.log(`--limit ${limit} passed: only tagging the first ${skus.length} SKUs.`);
  }

  const batches = chunk(skus, BATCH_SIZE);
  console.log(`Tagging in ${batches.length} batch(es) of up to ${BATCH_SIZE} SKUs each.`);

  let succeeded = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    process.stdout.write(`Batch ${i + 1}/${batches.length} (${batch.length} SKUs)... `);
    const result = await patchProducts(batch);
    if (result.ok) {
      console.log('OK');
      succeeded += batch.length;
    } else {
      console.log(`FAILED (status ${result.status})`);
      console.error(result.body);
      failed += batch.length;
      failures.push({ batch, result });
    }
    if (i < batches.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\nDone tagging: ${succeeded} succeeded, ${failed} failed.`);
  if (failures.length) {
    console.error(`${failures.length} batch(es) failed — see output above. Re-run the script; it is safe to re-run (idempotent, PATCH just sets the same field again).`);
  }

  if (dryRun) {
    console.log('\n[dry-run] Skipping spot-check verification.');
    return;
  }

  // Spot-check a handful of SKUs to confirm the field actually landed.
  const sampleSize = Math.min(5, skus.length);
  const sample = skus.slice(0, sampleSize).concat(skus.slice(-sampleSize)).filter((v, i, a) => a.indexOf(v) === i);
  console.log(`\nSpot-checking ${sample.length} SKUs via GET /product/:id ...`);
  for (const sku of sample) {
    const result = await getProduct(sku);
    if (result.ok) {
      const flag = result.data?.attributedata?.['bto-picklist-exclude'];
      console.log(`  ${sku}: bto-picklist-exclude = ${JSON.stringify(flag)}`);
    } else {
      console.log(`  ${sku}: could not verify (status ${result.status})`);
    }
  }

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
