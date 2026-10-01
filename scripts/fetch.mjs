// Fetches every feed in feeds.json and writes feed.json for the site.
// Run locally with:  node scripts/fetch.mjs
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import Parser from "rss-parser";

/* ---------- Settings ---------- */
const MAX_AGE_HOURS = 72;      // drop stories older than this (a source can override with "days" in feeds.json)
const PER_SOURCE = 15;         // max stories kept per source
const OG_IMAGE_LOOKUPS = 120;  // max article pages opened per run to find a missing photo
const TIMEOUT_MS = 15000;
const CONCURRENCY = 8;
const PREV_URL = process.env.PREV_URL || "";   // last published feed.json (for caching)
const UA = "Mozilla/5.0 (compatible; TheBriefReader/1.0; personal RSS reader)";

const parser = new Parser({
  timeout: TIMEOUT_MS,
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
      ["media:group", "mediaGroup"],
      ["content:encoded", "contentEncoded"],
      ["itunes:image", "itunesImage"],
    ],
  },
});

/* ---------- Helpers ---------- */
const sleepless = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);

async function get(url, accept) {
  const res = await sleepless(fetch(url, { headers: { "User-Agent": UA, Accept: accept }, redirect: "follow" }), TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const hash = s => createHash("sha1").update(s).digest("hex").slice(0, 12);
const decode = s => s
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#039;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const clean = s => decode(String(s || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? s.slice(0, s.lastIndexOf(" ", n) > 0 ? s.lastIndexOf(" ", n) : n).replace(/[,.;:]$/, "") + "…" : s);
const normTitle = t => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
const absolute = (u, base) => { try { return new URL(u, base).href; } catch { return null; } };

function pickImage(it) {
  const urls = [];
  const fromMedia = arr => (arr || []).forEach(m => {
    const a = m?.$ || m;
    if (a?.url && (!a.medium || a.medium === "image") && !/video|audio/.test(a.type || "")) urls.push({ url: a.url, w: +a.width || 0 });
  });
  fromMedia(it.mediaContent);
  fromMedia(it.mediaGroup?.["media:content"]);
  fromMedia(it.mediaThumbnail);
  if (it.enclosure?.url && /^image\//.test(it.enclosure.type || "image/")) urls.push({ url: it.enclosure.url, w: 0 });
  if (it.itunesImage?.$?.href) urls.push({ url: it.itunesImage.$.href, w: 0 });
  const html = it.contentEncoded || it.content || "";
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) urls.push({ url: m[1], w: 0 });
  urls.sort((a, b) => b.w - a.w);              // prefer the largest version
  const best = urls.find(u => /^https?:/.test(u.url) && !/pixel|spacer|1x1|feedburner/i.test(u.url));
  return best ? decode(best.url) : null;
}

async function ogImage(link) {
  const html = await get(link, "text/html");
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["'][^>]*>/i);
  const c = m && m[0].match(/content=["']([^"']+)["']/i);
  return c ? absolute(decode(c[1]), link) : null;
}

async function pool(list, n, fn) {
  const out = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } }));
  return out;
}

/* ---------- Load config and previous run ---------- */
const feeds = JSON.parse(await readFile(new URL("../feeds.json", import.meta.url), "utf8"));
let prev = { items: [] };
try {
  prev = PREV_URL ? JSON.parse(await get(PREV_URL, "application/json"))
                  : JSON.parse(await readFile(new URL("../feed.json", import.meta.url), "utf8"));
} catch { /* first run */ }
const prevById = new Map((prev.items || []).map(i => [i.id, i]));

/* ---------- Fetch all feeds ---------- */
const jobs = Object.entries(feeds).flatMap(([category, list]) => list.map(src => ({ category, ...src })));
const cutoffFor = src => Date.now() - (src.days ? src.days * 24 : MAX_AGE_HOURS) * 3600e3;
const report = {};

const results = await pool(jobs, CONCURRENCY, async src => {
  const cutoff = cutoffFor(src);
  try {
    const xml = await get(src.url, "application/rss+xml, application/atom+xml, application/xml, text/xml, */*");
    const feed = await parser.parseString(xml);
    const items = (feed.items || []).map(it => {
      const link = absolute(it.link || it.guid || "", src.url);
      const title = clean(it.title);
      const date = new Date(it.isoDate || it.pubDate || 0);
      if (!link || !title || isNaN(date) || date.getTime() < cutoff) return null;
      const id = hash(link);
      return {
        id, category: src.category, source: src.name, title,
        summary: clip(clean(it.contentSnippet || it.summary || it.content || ""), 220),
        link,
        image: pickImage(it) || prevById.get(id)?.image || null,
        published: date.toISOString(),
      };
    }).filter(Boolean).sort((a, b) => b.published.localeCompare(a.published)).slice(0, PER_SOURCE);
    report[src.name] = { ok: true, count: items.length };
    return items;
  } catch (e) {
    // keep last run's stories from this source so it doesn't vanish on a blip
    const kept = (prev.items || []).filter(i => i.source === src.name && Date.parse(i.published) >= cutoff);
    report[src.name] = { ok: false, error: e.message, kept: kept.length };
    return kept;
  }
});

/* ---------- Merge, de-duplicate ---------- */
const seenLinks = new Set(), seenTitles = new Set();
let items = results.flat().sort((a, b) => b.published.localeCompare(a.published)).filter(it => {
  const t = normTitle(it.title);
  if (seenLinks.has(it.link) || seenTitles.has(t)) return false;
  seenLinks.add(it.link); seenTitles.add(t); return true;
});

/* ---------- Find photos for stories without one ---------- */
const missing = items.filter(i => !i.image).slice(0, OG_IMAGE_LOOKUPS);
await pool(missing, CONCURRENCY, async it => { try { it.image = await ogImage(it.link); } catch {} });

/* ---------- Market data (Yahoo Finance) ---------- */
const marketGroups = JSON.parse(await readFile(new URL("../markets.json", import.meta.url), "utf8"));
const quotes = Object.entries(marketGroups).flatMap(([group, list]) => list.map(q => ({ group, ...q })));
const prevQuotes = new Map((prev.markets || []).map(q => [q.symbol, q]));

const markets = (await pool(quotes, 4, async q => {
  try {
    const chart = async range => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(q.symbol)}?${range}`;
      const r = JSON.parse(await get(url, "application/json")).chart.result[0];
      return { r, closes: r.indicators.quote[0].close.filter(c => c != null) };
    };
    let { r, closes } = await chart("range=1mo&interval=1d"), prevClose = closes.at(-2), sparkRange = "1M";
    if (closes.length < 5) {   // thin daily history (e.g. OMX Iceland 15): use today's intraday prices
      ({ r, closes } = await chart("range=1d&interval=5m"));
      prevClose = r.meta.chartPreviousClose; sparkRange = "1D";
    }
    const price = r.meta.regularMarketPrice ?? closes.at(-1);
    if (!(Number.isFinite(price) && Number.isFinite(prevClose))) throw new Error("no price");
    return {
      symbol: q.symbol, name: q.name, group: q.group, ticker: !!q.ticker, unit: q.unit || "", currency: r.meta.currency,
      price, change: price - prevClose, changePct: (price / prevClose - 1) * 100,
      spark: (sparkRange === "1M" ? closes.slice(-22) : closes).map(c => +c.toPrecision(6)), sparkRange,
      time: new Date(r.meta.regularMarketTime * 1000).toISOString(),
    };
  } catch (e) {
    console.log(`  ✗ ${q.symbol.padEnd(24)} ${e.message}`);
    return prevQuotes.get(q.symbol) || null;   // keep last known quote on a blip
  }
})).filter(Boolean);

/* ---------- Write ---------- */
const out = { updated: new Date().toISOString(), count: items.length, categories: Object.keys(feeds), markets, sources: report, items };
await writeFile(new URL("../feed.json", import.meta.url), JSON.stringify(out, null, 1));

const ok = Object.values(report).filter(r => r.ok).length;
console.log(`feed.json: ${items.length} stories from ${ok}/${jobs.length} sources, ${markets.length}/${quotes.length} market quotes`);
for (const [name, r] of Object.entries(report)) console.log(`  ${r.ok ? "✓" : "✗"} ${name.padEnd(24)} ${r.ok ? r.count : r.error}`);
