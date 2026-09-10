// Reference implementation: applying the SAME BTO exclusion list to
// Microsoft Advertising (Bing Ads) — UET tag (client-side) and Microsoft
// Conversion API / CAPI (server-side, Stape).
//
// BACKGROUND (researched 2026-09-10): Microsoft Advertising has no
// per-item "exclude from catalog" flag equivalent to Meta/Google's
// content_id exclusion. Its matching relies on:
//   1. The Microsoft Merchant Center (MMC) product feed — each product's
//      `id` (built from channel:contentLanguage:targetCountry:offerId,
//      where `offerId` is effectively your SKU).
//   2. Conversion-side item identifiers sent via the UET tag
//      (`ecomm_prodid`, client-side) and/or Microsoft's server-side CAPI
//      (`customData.itemIds` / `customData.items[].id`, POST to
//      capi.uet.microsoft.com).
//
// There is no "hide this offerId from matching" toggle inside Microsoft
// Advertising itself — the only two levers are campaign-level bidding
// exclusions (ProductCondition/ProductScope — NOT what we need here) and
// simply never emitting the excluded SKU in the first place, both in the
// MMC feed and in every conversion event. So the fix mirrors what's
// already done for Meta/Google: filter using the SAME exclusion list
// (data/exclusion-list.json from this repo), at the tag/event layer.
//
// TWO PLACES TO WIRE THIS IN:
//
// =====================================================================
// A) SERVER CONTAINER (GTM-WLXRPD6V, via Stape) — filtering the UET CAPI
//    tag's item ids before they're sent to capi.uet.microsoft.com.
// =====================================================================
//
// Create this as a GTM Server Custom Template of type VARIABLE (same
// pattern as server-container-custom-template.js already in this repo —
// reuses the same cached exclusion-list fetch, just exposes a filter
// function instead of a single-id lookup). In "Permissions" add:
//   - Send HTTP Requests: allow https://raw.githubusercontent.com/*
//   - Access Template Storage: allow
//
// const sendHttpRequest = require('sendHttpRequest');
// const templateStorage = require('templateStorage');
// const JSON = require('JSON');
// const getTimestampMillis = require('getTimestampMillis');
// const logToConsole = require('logToConsole');
// const Promise = require('Promise');
//
// const EXCLUSION_LIST_URL = 'https://raw.githubusercontent.com/JydskEmblemFabrik/jef-bto-exclusion-list/main/data/exclusion-list.json';
// const CACHE_KEY = 'bto_exclusion_set';
// const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
//
// function fetchList() {
//   return new Promise((resolve, reject) => {
//     sendHttpRequest(EXCLUSION_LIST_URL, (statusCode, headers, body) => {
//       if (statusCode >= 200 && statusCode < 300 && body) {
//         const parsed = JSON.parse(body);
//         resolve(parsed && parsed.skus ? parsed.skus : []);
//       } else {
//         logToConsole('BTO exclusion list fetch failed, status: ' + statusCode);
//         reject('fetch_failed');
//       }
//     }, { method: 'GET' });
//   });
// }
//
// function loadSkus() {
//   const cached = templateStorage.getItemCopy(CACHE_KEY);
//   if (cached && (getTimestampMillis() - cached.fetchedAt) < CACHE_TTL_MS) {
//     return Promise.resolve(cached.skus);
//   }
//   return fetchList().then((skus) => {
//     templateStorage.setItemCopy(CACHE_KEY, { skus, fetchedAt: getTimestampMillis() });
//     return skus;
//   }).catch(() => cached ? cached.skus : []);
// }
//
// // Exposed to the container: an async function(itemIdsArray) -> filteredArray
// return loadSkus().then((skus) => {
//   const excludedSet = {};
//   for (const i in skus) excludedSet[skus[i]] = true;
//   return function (itemIds) {
//     const out = [];
//     for (const i in itemIds) {
//       if (!excludedSet[itemIds[i]]) out.push(itemIds[i]);
//     }
//     return out;
//   };
// });
//
// USAGE in your Microsoft Ads CAPI server-side tag: wherever the tag
// currently builds `customData.itemIds` (or `customData.items[].id`) from
// the incoming order/cart data, call this variable first and pass the
// filtered array through instead of the raw one. If your CAPI tag is a
// Stape community template rather than hand-rolled, check whether it
// accepts a pre-filtered items array as input, or fork it to add this
// filter step at the point items are assembled.
//
// =====================================================================
// B) WEB CONTAINER (GTM-MJV6CSR) — filtering `ecomm_prodid` before the
//    UET tag fires client-side.
// =====================================================================
//
// This mirrors web-container-preload-and-filter.js already in this repo.
// Add a Custom JS variable (or extend the existing "cjs - formatted items"
// variable if it already builds a shared filtered-items list reused across
// Meta/Google/Bing):
//
// function() {
//   var excludedSkus = {{BTO Exclusion Set}}; // reuse the same preloaded set
//                                              // from web-container-preload-and-filter.js
//   var rawProdIds = {{ecomm_prodid - raw}}; // however you currently build this array/string
//   var ids = (rawProdIds || []).filter ? rawProdIds : String(rawProdIds).split(',');
//   return ids.filter(function (id) {
//     return !excludedSkus[String(id).trim()];
//   });
// }
//
// Wire this filtered variable into the UET tag's `ecomm_prodid` field
// (Bing Ads Universal Event Tracking tag in GTM), replacing whatever
// currently feeds it.
//
// =====================================================================
// C) MICROSOFT MERCHANT CENTER FEED — no GTM involvement, but just as
//    important: the excluded SKUs should never be submitted as products
//    in the MMC feed in the first place (same principle as the Meta/Google
//    catalog feed already excluding BTO picklist SKUs). If your product
//    feed export already filters using data/exclusion-list.json (or the
//    same PIM `bto-picklist-exclude` field) for Meta/Google, apply the
//    identical filter to whatever generates the Microsoft Merchant Center
//    feed — it is a separate feed/export, not something GTM touches.
// =====================================================================
//
// Test in GTM's Preview/debug mode before publishing, same as the
// Meta/Google wiring.
