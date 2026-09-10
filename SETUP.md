# BTO exclusion list — automated daily refresh

## Status (2026-09-10): fungerer, fuldautomatisk

Efter et par forsøg er automatiseringen nu færdig og bekræftet virkende:

- Chainbox' "Lookup List" API viste sig at være en blindgyde (ingen SKU-data
  i det hele taget) — droppet.
- I stedet har PIM fået et nyt, brugerdefineret felt: `bto-picklist-exclude`
  (Boolean), som markerer en SKU som "kun en BTO-konfigurator-delkomponent,
  skal ikke matches som selvstændigt produkt".
- Alle 910 kendte SKU'er fra v3-rapporten er tagget: 881 direkte i PIM via
  API'et, og 29 (som ikke længere findes som selvstændige PIM-produkter) er
  hardcodet ind i scriptet som en fast tilføjelsesliste (se
  `MANUAL_ADDITIONS` i `scripts/build-exclusion-list.mjs`).
- Det daglige workflow forespørger nu PIM's `/productsearch` filtreret på
  `bto-picklist-exclude = true`, kombinerer med de 29 faste tilføjelser, og
  committer resultatet til `data/exclusion-list.json` — bekræftet at give
  præcis de samme 910 SKU'er som den manuelle v3-liste.

Der er ikke længere nogen manuel vedligeholdelse af selve SKU-listen — kun
den ene ting beskrevet i "Ny BTO-SKU" nedenfor.

## Ny BTO-SKU i fremtiden — husk dette ene trin

Når der oprettes en ny BTO-konfigurator-delkomponent (et nyt gravering-,
bånd-, print- eller andet picklist-valg) som PIM-produkt, skal feltet
**"BTO Picklist Exclude"** sættes til **Ja/true** på det produkt i PIM
(Define-fanen → Attributes, eller direkte på produktet under fanen med
"Webshop Configuration"-felter).

- Glemmes dette trin, dukker den nye delkomponent op i morgendagens
  automatiske liste-genberegning som en "almindelig" SKU — dvs. den bliver
  IKKE ekskluderet, og kan potentielt matches forkert i Meta/Google/Bing.
- Der er ingen anden vedligeholdelse — ingen kode, ingen GitHub, ingen
  Chainbox-henvendelse. Bare det ene checkbox-klik i PIM, én gang, ved
  oprettelsen.
- Det daglige workflow (kl. 04:00 UTC) fanger automatisk alle SKU'er med
  dette felt sat til Ja, uden yderligere handling.

## Hvad dette er

Et lille GitHub-repo der hver dag (kl. 04:00 UTC, kan ændres) henter data fra
Chainbox' officielle PIM API (samme API-bruger I allerede har fra et tidligere
projekt — ingen ny henvendelse til Chainbox nødvendig), beregner de SKU'er der
skal ekskluderes fra Meta/Google/Bing content_id-matching (samme metode som i
den manuelle v3-rapport — nu 100% automatisk via PIM-feltet ovenfor), og
publicerer resultatet som en offentlig, versioneret JSON-fil i selve repoet.

GTM (web-container GTM-MJV6CSR og server-container GTM-WLXRPD6V via Stape)
henter denne fil med et par timers cache, i stedet for at ringe til BTO's API
ved hvert enkelt event.

Ingen ny Chainbox-involvering, ingen ny betalt infrastruktur.

## Sådan sætter du det op (allerede gjort for jeres repo — til reference)

1. **Opret et nyt (privat eller offentligt) GitHub-repo** hos JEF/jer selv,
   fx `jef-bto-exclusion-list`. ✅ gjort.
2. **Læg indholdet af denne mappe ind i repoet** (`.github/`, `scripts/`,
   `data/`) og push til `main`. ✅ gjort.
3. **Under Settings → Secrets and variables → Actions**, de fem secrets er
   allerede oprettet:
   - `PIM_API_BASE_URL`, `PIM_ORG_ID`, `PIM_PIM_ID`, `PIM_API_USERNAME`,
     `PIM_API_PASSWORD`. ✅ gjort.

   **Sikkerhedsnote (stadig aktuel):** da adgangskoden har været i almindelig
   tekst undervejs (mail, chat), er det stadig god praksis at bede Chainbox om
   at rotere adgangskoden til denne bruger på et tidspunkt — ikke fordi noget
   er gjort forkert, men fordi den har passeret flere steder.
4. **Det brugerdefinerede PIM-felt er oprettet**: Define → Attributes → Code
   `bto-picklist-exclude`, Datatype Boolean, Set "Webshop Configuration",
   Read only: Nej, ingen ERP-mapping. ✅ gjort.
5. **Alle 910 kendte SKU'er er tagget** (881 direkte i PIM, 29 via en fast
   liste i scriptet — se ovenfor). ✅ gjort.
6. **Workflowet er testet og bekræftet**: genberegner præcis de samme 910
   SKU'er hver gang, 100% overlap med den oprindelige v3-liste. ✅ gjort.
7. **Repoets "raw" URL**, som GTM skal pege på:
   ```
   https://raw.githubusercontent.com/JydskEmblemFabrik/jef-bto-exclusion-list/main/data/exclusion-list.json
   ```
8. **Resterende trin (endnu ikke udført) — GTM-opsætning:**
   - **I Stape/serveren container:** opret en Custom Template (Variable) ud
     fra `gtm-reference/server-container-custom-template.js`, indsæt
     raw-URL'en ovenfor, og brug variablen til at filtrere content_id'er
     fra, før de sendes til Meta CAPI / Google, i de(n) tag(s) hvor det sker
     i dag.
   - **I web-containeren:** tilføj Custom HTML-tagget og Custom JS-variablen
     fra `gtm-reference/web-container-preload-and-filter.js`, og lad den
     erstatte (eller supplere) den nuværende regex `^R\d+-\d+$` i jeres
     eksisterende "cjs - formatted items (kun sælgbare produkter)"-variabel.
   - **Bing Ads / Microsoft Advertising** (se `gtm-reference/` for detaljer,
     tilføjes): samme exclusion-liste bruges til at filtrere
     `ecomm_prodid` (UET-tagget) og `itemIds`/`items[]` (Microsoft CAPI), og
     de ekskluderede SKU'er skal aldrig sendes til Microsoft Merchant
     Center-feedet i første omgang. Microsoft har ikke et separat
     per-vare-udelukkelsesfelt som Meta/Google — filtrering sker udelukkende
     i tag-laget, med samme liste.
   - **Test i GTM's egen Preview/debug-tilstand** før I publicerer.

## Hvordan automatikken virker (teknisk)

`scripts/build-exclusion-list.mjs` kalder Chainbox PIM's `POST
/productsearch` med et filter på `bto-picklist-exclude = true`, paginerer
igennem alle sider, lægger de 29 faste tilføjelser oveni, og skriver
resultatet til `data/exclusion-list.{json,txt,regex.txt}` — men kun hvis
resultatet indeholder mindst 500 SKU'er (en sikkerhedsgrænse, der forhindrer
at en fejlkonfiguration eller API-ændring nulstiller listen ved en fejl).
Hvis grænsen ikke nås, fejler jobbet synligt, og den tidligere gode liste
forbliver urørt.

`scripts/bulk-tag-skus.mjs` er det engangs-script, der satte
`bto-picklist-exclude = true` på alle 910 SKU'er første gang. Det er trygt at
køre igen (idempotent), hvis I nogensinde har brug for at gen-tagge en stor
mængde SKU'er på én gang — kør det manuelt via "Bulk-tag BTO SKUs in
PIM"-workflowet i Actions-fanen, med `limit` sat til et lille tal først som
en røgtest.

## Filer i denne pakke

- `.github/workflows/update-exclusion-list.yml` — det daglige job.
- `.github/workflows/bulk-tag.yml` — engangs/genkørbart bulk-tag-job.
- `.github/workflows/diagnose.yml` — historisk diagnoseværktøj (Lookup List
  vs. productsearch), ikke længere nødvendigt, men efterladt til reference.
- `scripts/build-exclusion-list.mjs` — den daglige beregning (PIM API →
  SKU-liste).
- `scripts/bulk-tag-skus.mjs` — engangs bulk-tagging af PIM-produkter.
- `scripts/diagnose-productsearch.mjs` — historisk diagnoseværktøj.
- `data/exclusion-list.json` / `.txt` / `.regex.txt` — den aktuelle,
  automatisk genererede liste (910 SKU'er).
- `data/bulk-tag-not-found.json` — de 29 SKU'er, der ikke kunne tagges i PIM
  (findes ikke som selvstændige produkter), til reference.
- `gtm-reference/server-container-custom-template.js` — Stape/server-side kode.
- `gtm-reference/web-container-preload-and-filter.js` — web-container kode.
