# AGENTS.md: notes for AI assistants

You're helping someone set up or change **BTL Label Autopilot**: a Cloudflare Worker that buys shipping labels through Shippo when they make a sale, and queues the label pictures for a **BTL Print Bridge** (ESP32-S3 board on a USB label printer) to print. Human guide: [README.md](README.md). Video walkthrough: coming soon on [BTL's YouTube](https://www.youtube.com/@BTLPhotoTech). Made by BTL.

## Rules

- **Never ask the person to paste secrets into the chat.** Tell them where to paste them themselves: the Cloudflare deploy form, Cloudflare → Worker → Settings → Variables and Secrets, or the bridge's own page. This covers the Shippo live key, the admin password, Stripe keys and the queue token.
- **Live labels cost real money.** Test with the settings page's "Print a free test label" button (it uses a `shippo_test_` key and buys nothing). Don't run "Check for new orders now" or switch on auto-buy for someone without them knowing it can buy labels.
- The person, not you, ticks Shippo/Cloudflare/Stripe terms and payment settings.
- Normal setup needs **no code changes**. Everything is on the `/admin` settings page.

## How it fits together

1. Sale on a marketplace → Shippo imports it as an order (the person connects stores in Shippo).
2. Cron every 15 min (`wrangler.jsonc`) → `checkOrders()` lists Shippo orders with `order_status[]=PAID` and `start_date` = KV `orders_since` (set when auto-buy is first switched on). It skips orders with `shop_app` "Shippo"/"CSV_Import", orders that already have a transaction, and ones marked in KV `order:<id>`.
3. `buyAndQueue()`: POST `/shipments/` (from address in settings, parcel from settings, weight from item rules → order weight → default), picks the cheapest rate (USPS only unless set to any), enforces the price cap, POST `/transactions/` with `label_file_type: "PNG"` and `order` (so Shippo marks it shipped and sends tracking to the marketplace), downloads the PNG and stores it as KV `job:<id>` with metadata `{text}` (item codes + store tag), and appends the id to KV `queue`.
4. Bridge polls `GET /print/next` (Bearer token = KV `print_token`, header `X-Bridge-Accepts: image/png`). The response is the PNG with headers `X-Job-Id` and `X-Label-Text`. The bridge decodes the PNG, scales it to 4x6 at 203 dpi, prints it as ZPL `^GFA` or TSPL `BITMAP`, overlays the text, then calls `POST /print/ack?id=`. KV reads can lag ~60 s, so the bridge (firmware 1.9.2+) also remembers recent job ids and never prints one twice.
5. Optional Stripe: `POST /stripe` (signature check with `STRIPE_WEBHOOK_SECRET`; line items read with `STRIPE_API_KEY`). If the label can't be bought, it creates a Shippo order instead.

## Files

- `src/index.js`: the whole Worker (no dependencies).
- `wrangler.jsonc`: name, KV binding `LABELS`, cron.
- `.dev.vars.example` and `package.json` → `cloudflare.bindings`: what the Deploy button asks for.

## Settings (KV key `settings`, edited on `/admin`)

`autoBuy`, `capCents`, `carriers` ("usps" | "any"), `parcel` {length,width,height in inches}, `defaultOz`, `from` {name, street1, street2, city, state, zip, email, phone}. Shippo requires email and phone. Also `stores` (comma list of Shippo `shop_app` names; blank = all), `rules` [{match, code, oz}] (case-insensitive "contains", `|` = or, first match wins), `showSite`, `siteTags`, `testKey`.

## Common problems

- `address_from.email` / `phone must not be empty`: fill both in on the settings page.
- Bridge log `Queue: HTTP 401`: token mismatch. Re-copy from `/admin`.
- `HTTP 426`: bridge firmware older than 1.9.2. Update on the bridge's page.
- Garbled print: bridge setting **Printer language** must match the printer (ZPL for Zebra/Rongta-style, TSPL for many cheap 4x6 printers).
- Order not printed: see "Recent labels" on `/admin` for the reason (over cap, no rates, address problem). The person can buy it in Shippo by hand.
- Cloudflare free plan: 10 ms CPU per request is fine because the image work happens on the bridge. Keep it that way; don't decode images in the Worker.

## Testing changes locally

`npx wrangler dev` runs it with a local KV. Mock Shippo with `fetch` stubs. Don't point a dev copy at a live Shippo key.
