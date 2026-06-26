# ComicGauge

AI comic scanner + eBay market comps + Hot Comics auto-board.
Same stack as CardGauge: **GitHub → Render**, no Wix. Backend serves the static frontend.

## What v1.5 does
- **Search a title** → live eBay active listings (low / avg / high), comic-normalized query.
- **Scan a cover** → vision ID → same market lookup.
- **Sold comps** → deep-link to eBay's completed-sales view with your EPN tag (compliant; no gated sold-data API).
- **Hot Comics board** → re-pulls live ranges for a seed watchlist and re-ranks by live listing activity. Auto-current on every load.

v2 later: CGC ROI calculator, Supabase-stored value history, scheduled re-rank job.

## Deploy (Render Web Service)
1. Push this folder to a new GitHub repo (e.g. `comicgauge-api`).
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install`  ·  Start command: `npm start`
4. Add environment variables (NOT in GitHub):
   - `EBAY_CLIENT_ID` — eBay app Client ID (Browse API)
   - `EBAY_CLIENT_SECRET` — eBay app Client Secret
   - `VISION_API_KEY` — same vision key your CardGauge scanner uses
   - `REFRESH_SECRET` — any string; guards the hot-board refresh endpoint
5. Deploy. Visit `/api/affiliate-test` to confirm EPN tracking.
6. Point `comicgauge.com` at the Render service (custom domain).

## Endpoints
- `GET  /api/market?q=Amazing Spider-Man 300 CGC 9.8`
- `POST /api/scan` (JSON `{image: dataURL}` or multipart `image`)
- `GET  /api/hot-comics`
- `POST /api/hot-comics/refresh` (header `x-refresh-secret`)
- `GET  /api/affiliate-test`, `GET /api/health`

## Notes
- eBay **active** listings come from the Browse API. **Sold** prices are gated (Marketplace Insights, partner-only), so we link out to eBay's sold view instead — exactly how CardGauge stays compliant.
- The vision call defaults to an OpenAI-style endpoint reading `VISION_API_KEY`. Swap the provider in `identifyComicFromImage()` if your scanner uses a different one.
