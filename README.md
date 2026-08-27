# रसुवा–भोटेकोशी बाढी · लाइभ बुलेटिन (क्लोन)

A clone of [nirajbhusal.github.io/rasuwa-flood-bulletin](https://nirajbhusal.github.io/rasuwa-flood-bulletin/)
that gets its content from the external sources listed in that page's **स्रोत** section,
instead of from hard-coded text.

The original is a 656 KB single HTML file whose figures are written into the markup and
refreshed by hand (it polls its own `latest.json`, `dhm-rivers.json`, `family.json`).
This clone keeps the layout, the Nepali UI and the section structure, but every number and
headline on the page is fetched at load time from an upstream that the original cites.

## Where the content comes from

| Section | Upstream | How |
|---|---|---|
| लाइभ घटना | BIPAD Portal `api/v1/incident/` (NDRRMA) | direct from the browser — the portal sends `Access-Control-Allow-Origin: *` |
| सक्रिय सतर्कता | BIPAD Portal `api/v1/alert/` | direct |
| नदी जलसतह | BIPAD Portal `api/v1/river/` (DHM gauges via hydrology.gov.np) | direct |
| नक्सा | the same incident + gauge coordinates, on OpenStreetMap tiles | direct |
| लाइभ समाचार | RSS: रातोपाटी, अनलाइनखबर, नागरिक, सेतोपाटी, Khabarhub (EN), The Kathmandu Post | via `data/live.json`, else a public CORS proxy |
| हेल्पलाइन / स्थानीय सम्पर्क | the published DAO and CAO numbers carried over from the original | `data/helpline.json`, `data/contacts.json` |
| स्रोत | all 168 links from the original's स्रोत section, grouped | `data/sources.json` |

Incidents are narrowed to the hazard types that belong on a flood bulletin
(बाढी, पहिरो, डुबान, हिमताल विस्फोटन, हिमपहिरो, भारी वर्षा, पुल भत्किनु, डुबेर मृत्यु) over the
last 21 days. River gauges are narrowed to the भोटेकोशी–त्रिशूली–नारायणी corridor. News is
keyword-filtered with the list in `data/feeds.json`.

**No casualty figures are copied from the original.** Those were editorial numbers keyed in by
its author; reproducing them in a clone would present stale counts as current. This page shows
only what its sources return, and says so on the page.

## Running it

Everything works from a plain static server — no build, no keys, no backend:

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 8787
```

Then open <http://localhost:8787/>. Any static server works (`npx serve .`, `python -m http.server`);
opening `index.html` straight off the disk will not, because `file://` pages cannot fetch.

## Optional: bake the feeds server-side

News sites send no CORS header, so in the browser the page hops through a public proxy
(`corsproxy.io`, then two `allorigins` endpoints, then `api.codetabs.com`). That works, but those
proxies rate-limit — under load they answer without a CORS header and the browser logs a wall of
CORS errors before the next one in the chain succeeds. **On a deployed site, use the aggregator
instead.** It removes the dependency entirely:

```bash
node scripts/fetch-sources.mjs
```

It reads every source in `data/feeds.json` and writes `data/live.json`, which the page prefers
when present. `.github/workflows/refresh.yml` runs it on a cron and commits the result, which is
how you would get "updates every five minutes" behaviour on GitHub Pages. Node 18+, no dependencies.

## Layout

```
index.html                 sections + sticky nav
assets/style.css           palette carried over from the original
assets/app.js              all fetching, filtering and rendering
data/feeds.json            the source registry — edit this to add a source
data/sources.json          168 archived source links, 12 groups
data/contacts.json         48 CAOs across 6 districts
data/helpline.json         DAO/DEOC/police lines per district
data/live.json             written by the aggregator (absent until it runs)
scripts/fetch-sources.mjs  the aggregator
serve.ps1                  local static server
```

## Adding a source

Add it to `data/feeds.json` under `rss` (anything serving RSS or Atom), `api`, `official` or
`social`. RSS entries need `id`, `name`, `url`, `site`; the browser and the aggregator both pick
them up with no further changes.

## Caveats

- X and Facebook have no readable public feed, so those sources are linked, not embedded — the
  same compromise the original settled on.
- `bipadportal.gov.np` reports `count` as `9223372036854775807`; ignore it and use `results.length`.
- The original's `docs/` and `img/` source links resolve back to the original site, since those
  files are its own.
