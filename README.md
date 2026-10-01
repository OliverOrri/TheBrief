# The Brief

A personal news site built from RSS feeds. Refreshes every 15 minutes via GitHub Actions and is hosted on GitHub Pages.

## How it works

- `feeds.json` lists the sources, grouped by category. Edit it to add or remove feeds.
- `markets.json` lists the stocks, indices and rates shown in the Markets tab (Yahoo Finance symbols).
- `scripts/fetch.mjs` reads every feed and the market prices, finds a photo for each story, removes duplicates and writes `feed.json`.
- `.github/workflows/update.yml` runs the fetch every 15 minutes and publishes the site.
- `index.html` is the site. It loads `feed.json` and shows sample stories if it can't.

## First-time setup

1. Copy these files into your repo and push to `main`.
2. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Open the **Actions** tab, pick **Update feed**, and press **Run workflow**.
4. The site goes live at `https://<your-username>.github.io/<repo-name>/`.

## Running it locally

```bash
npm install
npm run fetch     # writes feed.json and lists which sources worked
npm run serve     # open the URL it prints
```

## Adding a source

Add an entry to the right category in `feeds.json`:

```json
{ "name": "Source name", "url": "https://example.com/feed.xml" }
```

Stories older than 72 hours are dropped. For sources that post rarely, add `"days"` to keep them longer, e.g. `"days": 30`.

To add a new category, add a new key in `feeds.json`; the tab appears by itself. A key like `"AI/Research"` becomes a sub-tab (Research) inside the AI tab.

## Adding a stock

Add an entry to `markets.json` using its Yahoo Finance symbol (the one in the URL on finance.yahoo.com). `"ticker": true` also shows it in the strip at the top of every page.

```json
{ "symbol": "AMD", "name": "AMD" }
```

## Note

GitHub pauses scheduled workflows in a repo after 60 days without any commits. If the site stops updating, push any change or re-enable the workflow in the Actions tab.
