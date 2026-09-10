# BTO exclusion list — automated daily refresh

## Hvad dette er

Et lille GitHub-repo der hver dag (kl. 04:00 UTC, kan ændres) henter data fra
Chainbox' officielle PIM API (samme API-bruger I allerede har fra et tidligere
projekt — ingen ny henvendelse til Chainbox nødvendig), beregner de SKU'er der
skal ekskluderes fra Meta/Google content_id-matching (samme metode som i den
manuelle v3-rapport — nu 100% automatisk), og publicerer resultatet som en
offentlig, versioneret JSON-fil i selve repoet.

**Kilde-detalje:** scriptet bruger PIM API'ets "Lookup List" / "Lookup List
Item"-endpoints, ikke BTO-management's interne (browser-only) API. De to ting
ser ud til at være samme underliggende data — BTO's "picklists" er efter alt at
dømme bygget oven på PIM's generiske lookup-list-funktion (samme felter: code,
label, sortorder). Det er ikke 100% bekræftet endnu (se "Første kørsel" nedenfor),
men det betyder at jeres eksisterende, allerede-fungerende PIM-nøgle med stor
sandsynlighed er nok — uden at bede Chainbox om en ny, BTO-specifik nøgle.

GTM (web-container GTM-MJV6CSR og server-container GTM-WLXRPD6V via Stape)
henter denne fil med et par timers cache, i stedet for at ringe til BTO's API
ved hvert enkelt event.

Ingen Chainbox-involvering, ingen PIM-afhængighed, ingen ny betalt infrastruktur.

## Sådan sætter du det op

1. **Opret et nyt (privat eller offentligt) GitHub-repo** hos JEF/jer selv,
   fx `jef-bto-exclusion-list`.
2. **Læg indholdet af denne mappe ind i repoet** (`.github/`, `scripts/`, `data/`)
   og push til `main`.
3. **Under Settings → Secrets and variables → Actions**, opret disse fem
   secrets ud fra mailen fra Chainbox:
   - `PIM_API_BASE_URL` → `https://pim-api.service.chainbox.io`
   - `PIM_ORG_ID` → `jef`
   - `PIM_PIM_ID` → `pim`
   - `PIM_API_USERNAME` → API-brugerens ID (UUID'et fra mailen)
   - `PIM_API_PASSWORD` → adgangskoden fra mailen

   **Vigtigt:** brug KUN GitHub Secrets til dette — commit aldrig
   brugernavn/adgangskode direkte ind i en fil i repoet. Da adgangskoden er
   blevet sendt i almindelig tekst (mail, og videre i denne samtale), er det
   god praksis at bede Chainbox om at udstede en ny adgangskode til denne
   bruger, når den er lagt ind som secret — rent sikkerhedsmæssigt, ikke fordi
   noget er gjort forkert.
4. **Kør workflowet manuelt første gang** (fanen "Actions" → "Update BTO
   exclusion list" → "Run workflow"), og se loggen:
   - Scriptet sammenligner automatisk det nye resultat med den medfølgende
     seed-liste (910 SKU'er fra v3-rapporten) og skriver en procent-vis
     overlap i loggen. Højt overlap (fx 80-100%) bekræfter at PIM's
     "Lookup List"-data reelt er det samme som BTO's picklists. Lavt overlap
     er tegn på at antagelsen ikke holder, og at vi i så fald bliver nødt til
     at bede Chainbox om adgang til BTO-management's egen API i stedet.
   - Tjek desuden at `data/exclusion-list.json` ender med et realistisk antal
     SKU'er (~910). Scriptet advarer selv, hvis tallet er markant lavere.
5. **Notér repoets "raw" URL**, som GTM skal pege på:
   ```
   https://raw.githubusercontent.com/<org>/<repo>/main/data/exclusion-list.json
   ```
6. **I Stape/serveren container:** opret en Custom Template (Variable) ud fra
   `gtm-reference/server-container-custom-template.js`, indsæt jeres raw-URL,
   og brug den variabel til at filtrere content_id'er fra, før de sendes til
   Meta CAPI / Google, i de(n) tag(s) hvor det sker i dag.
7. **I web-containeren:** tilføj Custom HTML-tagget og Custom JS-variablen fra
   `gtm-reference/web-container-preload-and-filter.js`, og lad den erstatte
   (eller supplere) den nuværende regex `^R\d+-\d+$` i jeres eksisterende
   "cjs - formatted items (kun sælgbare produkter)"-variabel.
8. **Test i GTM's egen Preview/debug-tilstand** før I publicerer — jeg har
   skrevet koden ud fra dokumenterede GTM/Stape sandboxed-JS API'er, men har
   ikke selv kunnet køre den mod jeres live containere herfra.

## Adgang: løst via jeres eksisterende PIM API-bruger

Chainbox har tidligere oprettet en API-bruger med læse- og skriverettigheder
til PIM (base-URL `https://pim-api.service.chainbox.io`, org-id `jef`,
pim-id `pim`) — den samme bruger genbruges her, uden at Chainbox behøver
foretage sig noget nyt.

Ifølge Chainbox' egen API-dokumentation
(https://documentation.chainbox.dk/chainbox-api/pim-api/) bruger PIM API'et
Basic Auth (brugernavn/adgangskode i Authorization-headeren), og har blandt
andet et "Lookup List" og "Lookup List Item"-endpoint — som strukturelt minder
meget om BTO's picklister/picklist-valg (samme felter: code, label,
sortorder, og et item peger tilbage på sin liste). Scriptet er bygget ud fra
den antagelse.

**Det er endnu ikke 100% bekræftet at de to er identiske** — jeg har ikke
kunnet teste selve kaldet herfra (mit eget sandkassemiljø har ikke netadgang
til `pim-api.service.chainbox.io`), men det påvirker ikke GitHub Actions, som
har almindelig internetadgang. Første manuelle kørsel (se trin 4 ovenfor)
viser med det samme, om antagelsen holder, via en indbygget sammenligning med
den kendte, manuelt bekræftede 910-SKU-liste. Hvis overlappet er lavt, må vi
bede Chainbox om adgang til BTO-management's egen API i stedet — men det er
værd at prøve denne vej først, da den ikke kræver noget nyt fra Chainbox.

Da API-brugeren har både læse- og skriverettigheder, men denne automatisering
kun har brug for læsning, kalder scriptet udelukkende GET-endpoints — det kan
ikke ændre noget i PIM, uanset hvad kontoen i øvrigt har adgang til.

## Filer i denne pakke

- `.github/workflows/update-exclusion-list.yml` — det daglige job.
- `scripts/build-exclusion-list.mjs` — selve beregningen (PIM API → SKU-liste).
- `data/exclusion-list.json` / `.txt` / `.regex.txt` — seed-data fra den
  manuelle v3-rapport (910 SKU'er), så repoet virker med det samme, selv før
  det første automatiske løb.
- `gtm-reference/server-container-custom-template.js` — Stape/server-side kode.
- `gtm-reference/web-container-preload-and-filter.js` — web-container kode.
