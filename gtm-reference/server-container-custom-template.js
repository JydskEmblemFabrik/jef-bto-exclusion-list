// Reference implementation for the SERVER container (GTM-WLXRPD6V, via Stape).
//
// This is written as the "Sandboxed JavaScript" body of a GTM Server Custom
// Template of type VARIABLE. Create it via:
//   Templates → New → Variable Template → paste this into the code box,
// then in "Permissions" add:
//   - Send HTTP Requests: allow https://raw.githubusercontent.com/*
//   - Access Template Storage: allow (used as the cache)
//
// The variable returns a function you call with a content_id and get back
// true/false ("should this be excluded from the Meta/Google payload?").
// Wire it into your existing Meta CAPI / Google tag(s) — wherever content_id(s)
// are assembled — by calling this variable and filtering before sending.
//
// Replace EXCLUSION_LIST_URL with your repo's actual raw URL, e.g.:
//   https://raw.githubusercontent.com/<org>/<repo>/main/data/exclusion-list.json

const sendHttpRequest = require('sendHttpRequest');
const templateStorage = require('templateStorage');
const JSON = require('JSON');
const getTimestampMillis = require('getTimestampMillis');
const logToConsole = require('logToConsole');
const Promise = require('Promise');

const EXCLUSION_LIST_URL = 'https://raw.githubusercontent.com/<org>/<repo>/main/data/exclusion-list.json';
const CACHE_KEY = 'bto_exclusion_set';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — the list only changes once a day at most

function fetchList() {
  return new Promise((resolve, reject) => {
    sendHttpRequest(EXCLUSION_LIST_URL, (statusCode, headers, body) => {
      if (statusCode >= 200 && statusCode < 300 && body) {
        const parsed = JSON.parse(body);
        resolve(parsed && parsed.skus ? parsed.skus : []);
      } else {
        logToConsole('BTO exclusion list fetch failed, status: ' + statusCode);
        reject('fetch_failed');
      }
    }, { method: 'GET' });
  });
}

function loadSkus() {
  const cached = templateStorage.getItemCopy(CACHE_KEY);
  if (cached && (getTimestampMillis() - cached.fetchedAt) < CACHE_TTL_MS) {
    return Promise.resolve(cached.skus);
  }
  return fetchList().then((skus) => {
    templateStorage.setItemCopy(CACHE_KEY, { skus, fetchedAt: getTimestampMillis() });
    return skus;
  }).catch(() => {
    // fetch failed (network hiccup, GitHub down, etc.) — fall back to whatever
    // we had cached before, even if stale, rather than sending everything through unfiltered.
    return cached ? cached.skus : [];
  });
}

// Exposed to the container: an async function(contentId) -> boolean
return loadSkus().then((skus) => {
  const excludedSet = {};
  for (let i = 0; i < skus.length; i++) excludedSet[skus[i]] = true;
  return function (contentId) {
    return !!excludedSet[contentId];
  };
});
