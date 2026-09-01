/* ===============================
   COMICGAUGE
   AI SCANNER + EBAY COMIC MARKET BACKEND
   server.js — v1.6

   Changes from the live v1.5 — deliberately minimal, NOTHING RENAMED:
     1. FIXED: normalizeComicQuery double-hashed every issue number.
        "Amazing Spider-Man #300" became "##300". All 12 Hot Board
        seeds and every cover scan were affected, because the vision
        prompt returns "Title #Issue" already hashed. Typed searches
        were the only path that worked.
     2. resp.ok checks, so an eBay or OpenAI outage reports as an
        outage instead of silently looking like "no listings found".
     3. medianPrice added ALONGSIDE avgPrice. avgPrice is untouched,
        so public/index.html keeps working exactly as before.
     4. Vision guard: a refusal string no longer becomes an eBay query.
     5. New POST /api/event — logs frontend events to the Render log.
================================ */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = require("node-fetch");

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

/* ───────────────────────────────────────────────
   ENV / CONFIG — set these in the Render dashboard, not in GitHub:
     EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, VISION_API_KEY, REFRESH_SECRET
─────────────────────────────────────────────── */
const EPN_CAMPAIGN_ID = "5339149252";
const EPN_MKRID       = "711-53200-19255-0";

const EBAY_CLIENT_ID     = process.env.EBAY_CLIENT_ID || "";
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || "";
const VISION_API_KEY     = process.env.VISION_API_KEY || "";
const REFRESH_SECRET     = process.env.REFRESH_SECRET || "";

const EBAY_COMICS_CATEGORY = "63";

/* ───────────────────────────────────────────────
   AFFILIATE URL BUILDERS
   We never store eBay sold prices — we deep-link to eBay's own
   sold view with the EPN tag attached.
─────────────────────────────────────────────── */
function ebaySearchUrl(query, sold) {
  const base = "https://www.ebay.com/sch/i.html";
  const q = encodeURIComponent(query);
  const soldParams = sold ? "&LH_Sold=1&LH_Complete=1" : "";
  return `${base}?_nkw=${q}${soldParams}&_sacat=${EBAY_COMICS_CATEGORY}` +
    `&mkcid=1&mkrid=${EPN_MKRID}&siteid=0&campid=${EPN_CAMPAIGN_ID}&toolid=10001&mkevt=1`;
}

function addAffiliate(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.searchParams.set("mkcid", "1");
    u.searchParams.set("mkrid", EPN_MKRID);
    u.searchParams.set("siteid", "0");
    u.searchParams.set("campid", EPN_CAMPAIGN_ID);
    u.searchParams.set("toolid", "10001");
    u.searchParams.set("mkevt", "1");
    return u.toString();
  } catch (e) {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}campid=${EPN_CAMPAIGN_ID}&mkevt=1`;
  }
}

/* ───────────────────────────────────────────────
   COMIC QUERY NORMALIZER

   THE FIX IS THE (?<!#) BELOW.
   \b(\d{1,4})\b matches the digits inside "#300", because there is a
   word boundary between "#" and "3". So anything already formatted
   picked up a second hash. Every Hot Board seed and every vision
   result arrives already hashed — which is why only typed searches
   ever worked.
─────────────────────────────────────────────── */
function normalizeComicQuery(raw) {
  if (!raw) return "";
  let q = String(raw).trim().replace(/\s+/g, " ");

  let grade = "";
  const gradeMatch = q.match(/\b(cgc|cbcs|pgx)\s*\.?\s*(\d{1,2}(?:\.\d)?)\b/i);
  if (gradeMatch) {
    grade = `${gradeMatch[1].toUpperCase()} ${gradeMatch[2]}`;
    q = q.replace(gradeMatch[0], "").trim();
  }

  q = q
    .replace(/\bspider\s*-?\s*man\b/gi, "Spider-Man")
    .replace(/\bx\s*-?\s*men\b/gi, "X-Men")
    .replace(/\bfantastic\s*4\b/gi, "Fantastic Four");

  // Add a # only where there isn't one already, and never to a year.
  q = q.replace(/(?<!#)\b(\d{1,4})\b(?!\s*(cgc|cbcs|pgx))/i, (m, n) => {
    if (/^(19|20)\d{2}$/.test(n)) return n;
    return `#${n}`;
  });

  const out = grade ? `${q} ${grade}` : q;
  return out.replace(/\s+/g, " ").trim();
}

/* ───────────────────────────────────────────────
   EBAY BROWSE API — live ACTIVE listings only
─────────────────────────────────────────────── */
let cachedToken = null;
let tokenExpiry = 0;

async function getEbayToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    throw new Error("Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET env vars");
  }
  const creds = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");
  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${creds}`,
    },
    body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
  });
  if (!resp.ok) throw new Error(`eBay token HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.access_token) throw new Error("eBay token request failed");
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Math.round(m * 100) / 100;
}

async function fetchActiveMarket(query) {
  const cleanQuery = normalizeComicQuery(query);
  const token = await getEbayToken();

  const url =
    "https://api.ebay.com/buy/browse/v1/item_summary/search" +
    `?q=${encodeURIComponent(cleanQuery)}` +
    `&category_ids=${EBAY_COMICS_CATEGORY}` +
    "&filter=buyingOptions:{FIXED_PRICE}" +
    "&limit=20";

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });
  if (!resp.ok) throw new Error(`eBay Browse HTTP ${resp.status}`);
  const data = await resp.json();

  const items = (data.itemSummaries || []).map((it) => ({
    title: it.title,
    price: it.price ? Number(it.price.value) : null,
    currency: it.price ? it.price.currency : "USD",
    condition: it.condition || "",
    image: it.image ? it.image.imageUrl : "",
    url: addAffiliate(it.itemWebUrl),
  })).filter((it) => it.price != null);

  const prices = items.map((i) => i.price).sort((a, b) => a - b);
  const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

  return {
    cleanQuery,
    // avgPrice kept exactly as-is so the existing frontend is unaffected.
    avgPrice: avg ? Math.round(avg * 100) / 100 : null,
    // medianPrice is new and additive. A single $3k slab drags the mean
    // badly on a book with a wide condition spread.
    medianPrice: median(prices),
    lowPrice: prices.length ? prices[0] : null,
    highPrice: prices.length ? prices[prices.length - 1] : null,
    listingCount: items.length,
    image: items[0] ? items[0].image : "",
    listings: items.slice(0, 8),
    priceSource: "ebay_active",
  };
}

/* ───────────────────────────────────────────────
   VISION SCAN
─────────────────────────────────────────────── */
async function identifyComicFromImage(base64Image) {
  if (!VISION_API_KEY) throw new Error("Missing VISION_API_KEY env var");

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VISION_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Identify this comic book from its cover. Respond with ONLY a search " +
                "string in the format: Title #Issue (e.g. 'Amazing Spider-Man #300'). " +
                "Use the copyright indicia date, not the cover art style — reprints and " +
                "facsimile editions carry the original cover date. " +
                "If you can read a CGC/CBCS grade on a slab label, append it " +
                "(e.g. 'Amazing Spider-Man #300 CGC 9.8'). " +
                "If you cannot identify it, respond with exactly: UNKNOWN",
            },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64Image}` },
            },
          ],
        },
      ],
      max_tokens: 60,
    }),
  });
  if (!resp.ok) throw new Error(`Vision HTTP ${resp.status}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content?.trim() || "";

  // Don't send "I'm sorry, I can't identify this" to eBay as a search query.
  if (!text || /^unknown$/i.test(text) || text.length > 80) return "";
  if (/\b(sorry|cannot|can't|unable|i'm)\b/i.test(text)) return "";
  return text;
}

/* ───────────────────────────────────────────────
   KEY ISSUES WE WATCH

   This sorts by listingCount, which is SUPPLY, not demand — the books
   with the most copies for sale rank highest, which is the opposite of
   "hot". Real hotness needs week-over-week change in listing count and
   floor price, which needs a stored history table. Until that exists
   this is a hand-picked watchlist with live listing counts, and the
   frontend now says exactly that instead of claiming a hotness signal.
─────────────────────────────────────────────── */
const HOT_COMICS_SEED = [
  "Amazing Spider-Man #300",
  "Incredible Hulk #181",
  "Giant-Size X-Men #1",
  "New Mutants #98",
  "House of M #1",
  "Ultimate Fallout #4",
  "Batman Adventures #12",
  "Edge of Spider-Verse #2",
  "Venom #1 Lethal Protector",
  "Saga #1",
  "Walking Dead #1",
  "Daredevil #1 2024",
];

let hotBoardCache = { ts: 0, items: [] };
let hotBoardBuilding = null;
const HOT_CACHE_MS = 15 * 60 * 1000;

async function buildHotBoard() {
  const results = [];
  for (const title of HOT_COMICS_SEED) {
    try {
      const m = await fetchActiveMarket(title);
      results.push({
        title,
        avgPrice: m.avgPrice,
        medianPrice: m.medianPrice,
        lowPrice: m.lowPrice,
        highPrice: m.highPrice,
        listingCount: m.listingCount,
        image: m.image,
        soldCompsUrl: ebaySearchUrl(title, true),
        listingsUrl: ebaySearchUrl(title, false),
      });
    } catch (e) {
      console.warn(`Hot board skip "${title}": ${e.message}`);
    }
  }
  results.sort((a, b) => (b.listingCount || 0) - (a.listingCount || 0));
  return results;
}

/* Single-flight: 12 sequential eBay calls on a cold cache used to run
   once per concurrent visitor. Now they share one rebuild. */
function getHotBoard() {
  const fresh = Date.now() - hotBoardCache.ts < HOT_CACHE_MS;
  if (fresh && hotBoardCache.items.length) {
    return Promise.resolve({ items: hotBoardCache.items, cached: true });
  }
  if (!hotBoardBuilding) {
    hotBoardBuilding = buildHotBoard()
      .then((items) => {
        if (items.length) hotBoardCache = { ts: Date.now(), items };
        return { items: hotBoardCache.items, cached: false };
      })
      .catch((e) => {
        if (hotBoardCache.items.length) {
          return { items: hotBoardCache.items, cached: true, stale: true };
        }
        throw e;
      })
      .finally(() => { hotBoardBuilding = null; });
  }
  return hotBoardBuilding;
}

/* ───────────────────────────────────────────────
   ROUTES
─────────────────────────────────────────────── */

app.post("/api/scan", upload.single("image"), async (req, res) => {
  try {
    let base64;
    if (req.file) {
      base64 = req.file.buffer.toString("base64");
    } else if (req.body.image) {
      base64 = req.body.image.replace(/^data:image\/\w+;base64,/, "");
    } else {
      return res.status(400).json({ success: false, error: "No image provided" });
    }

    const identified = await identifyComicFromImage(base64);
    if (!identified) {
      return res.json({
        success: false,
        error: "Could not read that cover. Try again with the whole cover in frame, or use the search tab.",
      });
    }

    const market = await fetchActiveMarket(identified);
    console.log(`SCAN ok "${identified}" -> ${market.listingCount} listings`);

    return res.json({
      success: true,
      identified,
      query: market.cleanQuery,
      note: "These are asking prices from active eBay listings, not sold prices. Tap Sold Comps for real completed sales.",
      avgPrice: market.avgPrice,
      medianPrice: market.medianPrice,
      lowPrice: market.lowPrice,
      highPrice: market.highPrice,
      listingCount: market.listingCount,
      image: market.image,
      priceSource: market.priceSource,
      listings: market.listings,
      soldCompsUrl: ebaySearchUrl(market.cleanQuery, true),
      activeListingsUrl: ebaySearchUrl(market.cleanQuery, false),
      affiliate: { campid: EPN_CAMPAIGN_ID, active: true },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Scan error:", error);
    return res.status(500).json({ success: false, error: "Scan failed", details: error.message });
  }
});

app.get("/api/market", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ success: false, error: "Missing q param" });

    const market = await fetchActiveMarket(query);
    console.log(`MARKET "${query}" -> "${market.cleanQuery}" -> ${market.listingCount} listings`);

    return res.json({
      success: true,
      query: market.cleanQuery,
      note: "These are asking prices from active eBay listings, not sold prices. Tap Sold Comps for real completed sales.",
      avgPrice: market.avgPrice,
      medianPrice: market.medianPrice,
      lowPrice: market.lowPrice,
      highPrice: market.highPrice,
      listingCount: market.listingCount,
      image: market.image,
      priceSource: market.priceSource,
      listings: market.listings,
      soldCompsUrl: ebaySearchUrl(market.cleanQuery, true),
      activeListingsUrl: ebaySearchUrl(market.cleanQuery, false),
      affiliate: { campid: EPN_CAMPAIGN_ID, active: true },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Market error:", error);
    return res.status(500).json({ success: false, error: "Market lookup failed", details: error.message });
  }
});

app.get("/api/hot-comics", async (req, res) => {
  try {
    const board = await getHotBoard();
    return res.json({
      success: true,
      cached: board.cached,
      stale: !!board.stale,
      ranking: "active_listing_count",
      items: board.items,
      timestamp: hotBoardCache.ts,
    });
  } catch (error) {
    console.error("Hot board error:", error);
    return res.status(500).json({ success: false, error: "Hot board failed", details: error.message });
  }
});

app.post("/api/hot-comics/refresh", async (req, res) => {
  const secret = req.headers["x-refresh-secret"];
  if (!REFRESH_SECRET || secret !== REFRESH_SECRET) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }
  try {
    const items = await buildHotBoard();
    hotBoardCache = { ts: Date.now(), items };
    return res.json({ success: true, refreshed: true, count: items.length, timestamp: hotBoardCache.ts });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Refresh failed", details: error.message });
  }
});

/* Frontend event logging. Goes to the Render log for now — swap the
   console.log for a Supabase insert when you want it queryable. */
app.post("/api/event", (req, res) => {
  try {
    const b = req.body || {};
    console.log("EVENT " + JSON.stringify({
      event: String(b.event || "unknown").slice(0, 60),
      detail: b.detail ? String(b.detail).slice(0, 200) : undefined,
      count: b.count,
      ts: new Date().toISOString(),
    }));
  } catch (e) { /* never let logging break a page */ }
  res.json({ ok: true });
});

/* Runs through the normalizer, so this route would have caught the ##
   bug. In v1.5 it bypassed normalization and always looked healthy. */
app.get("/api/affiliate-test", (req, res) => {
  const testQuery = normalizeComicQuery("Amazing Spider-Man #300 CGC 9.8");
  res.json({
    success: true,
    message: "ComicGauge eBay affiliate tracking is active",
    campid: EPN_CAMPAIGN_ID,
    normalized: testQuery,
    sampleActiveUrl: ebaySearchUrl(testQuery, false),
    sampleSoldUrl: ebaySearchUrl(testQuery, true),
  });
});

app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    service: "comicgauge-api",
    version: "1.6",
    // If this shows a double hash, the deploy didn't take.
    normalizerCheck: normalizeComicQuery("Amazing Spider-Man #300"),
    env: {
      ebay: Boolean(EBAY_CLIENT_ID && EBAY_CLIENT_SECRET),
      vision: Boolean(VISION_API_KEY),
    },
  })
);

app.use(express.static("public"));

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Endpoint not found" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ComicGauge backend v1.6 running on port ${PORT}`);
  console.log(`Normalizer check: ${normalizeComicQuery("Amazing Spider-Man #300")}`);
});
