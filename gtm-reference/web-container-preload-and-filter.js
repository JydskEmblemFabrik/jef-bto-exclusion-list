// Reference implementation for the WEB container (GTM-MJV6CSR).
//
// A plain "Custom JavaScript Variable" in the web container must return
// synchronously — it can't itself do an async fetch(). So this is split in two:
//
// 1) A "Custom HTML" tag, firing once on "All Pages" (or "Consent Initialization"
//    if that fits your consent setup better), that fetches the list ONCE per
//    page load and caches it in sessionStorage so a repeat pageview in the same
//    browser session doesn't refetch it:
//
//    <script>
//    (function () {
//      var URL = 'https://raw.githubusercontent.com/<org>/<repo>/main/data/exclusion-list.json';
//      var CACHE_KEY = 'bto_exclusion_list_v1';
//      var CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
//
//      function applyList(skus) {
//        window.__btoExclusionSet = {};
//        for (var i = 0; i < skus.length; i++) window.__btoExclusionSet[skus[i]] = true;
//      }
//
//      try {
//        var cachedRaw = sessionStorage.getItem(CACHE_KEY);
//        if (cachedRaw) {
//          var cached = JSON.parse(cachedRaw);
//          if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
//            applyList(cached.skus);
//            return;
//          }
//        }
//      } catch (e) { /* sessionStorage unavailable — fall through to fetch */ }
//
//      fetch(URL)
//        .then(function (r) { return r.json(); })
//        .then(function (data) {
//          applyList(data.skus || []);
//          try {
//            sessionStorage.setItem(CACHE_KEY, JSON.stringify({ skus: data.skus, fetchedAt: Date.now() }));
//          } catch (e) { /* ignore quota/availability errors */ }
//        })
//        .catch(function () {
//          // Fetch failed — leave window.__btoExclusionSet undefined; the
//          // Custom JS Variable below treats "no data yet" as "don't exclude",
//          // so nothing is wrongly blocked, it's just not filtered this once.
//        });
//    })();
//    </script>
//
// 2) A "Custom JavaScript Variable" — this is what you actually reference from
//    your existing "cjs - formatted items (kun sælgbare produkter)" logic
//    (replacing, or running alongside, the current regex ^R\d+-\d+$ check):

function () {
  return function (contentId) {
    if (!window.__btoExclusionSet) return false; // list hasn't loaded yet this pageview — fail open
    return !!window.__btoExclusionSet[contentId];
  };
}

// Usage inside your existing formatting variable, per item:
//   var isExcluded = {{BTO Exclusion Check}}(item.id);
//   if (isExcluded) continue; // skip this line item
