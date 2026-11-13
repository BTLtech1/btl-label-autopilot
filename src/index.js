// BTL Label Autopilot
// Buys and prints shipping labels by itself when you make a sale.
//
//   Sale on Etsy / eBay / Shopify / ...  ->  Shippo imports the order
//   Every 15 minutes this Worker asks Shippo for new paid orders, buys the cheapest label
//   (under your price cap) and puts it in a print queue: the "mailbox".
//   A BTL Print Bridge next to your label printer checks the mailbox every few seconds
//   and prints whatever is in it, with your item codes stamped on the label.
//
// Settings live on the Worker's own page (/admin), so nothing here needs editing.
// Secrets (Cloudflare -> this Worker -> Settings -> Variables and Secrets):
//   SHIPPO_API_KEY          required. Your live Shippo API key (starts with shippo_live_).
//   ADMIN_PASSWORD          required. Password for the settings page.
//   STRIPE_WEBHOOK_SECRET   optional, only for your own Stripe checkout (starts with whsec_).
//   STRIPE_API_KEY          optional, with STRIPE_WEBHOOK_SECRET: a restricted key with
//                           "Checkout Sessions: Read" (starts with rk_live_).
// Storage: a KV namespace bound as LABELS (the Deploy button makes it for you).
//
// https://github.com/BTLtech1/btl-label-autopilot   Made by BTL.

const VERSION = "1.0.0";
const DAY = 60 * 60 * 24;
const KEEP_ORDERS = DAY * 60;   // how long "already handled" markers are kept
const KEEP_JOBS = DAY * 14;     // printed or not, labels leave the queue after this
const MAX_PER_CHECK = 8;        // orders handled per check (keeps inside the free plan's limits)
const SKIP_APPS = ["Shippo", "CSV_Import"]; // orders made by hand or by this Worker itself

const DEFAULTS = {
  autoBuy: false,
  capCents: 800,
  carriers: "usps",                   // "usps" or "any"
  packages: [{ name: "6x9 bubble mailer", length: 9, width: 6, height: 1 }],
  defaultOz: 4,
  from: { name: "", street1: "", street2: "", city: "", state: "", zip: "", email: "", phone: "" },
  stores: "",                         // blank = every store connected in Shippo
  rules: [],                          // [{ match: "gen 3", code: "G3", oz: 1.5 }]
  showSite: true,
  siteTags: { Etsy: "ET", eBay: "EB", Shopify: "SH", Amazon: "AZ", WooCommerce: "WC", Stripe: "ST" },
  testKey: "",
};

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkOrders(env).catch((e) => console.log("check error", e.message)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (!env.LABELS) return text("The LABELS storage (KV namespace) isn't connected to this Worker. See the README.", 500);
    if (p.startsWith("/print/")) return printRoute(request, url, env);
    if (p === "/stripe" && request.method === "POST") return stripeHook(request, env);
    if (p === "/admin" || p.startsWith("/admin/")) return adminRoute(request, url, env);
    if (p === "/") return Response.redirect(url.origin + "/admin", 302);
    return text("Not found", 404);
  },
};

// ---------------------------------------------------------------- settings
async function getSettings(env) {
  const s = (await env.LABELS.get("settings", "json")) || {};
  return {
    ...DEFAULTS, ...s,
    packages: s.packages?.length ? s.packages : s.parcel ? [{ name: "Package", ...s.parcel }] : DEFAULTS.packages,
    from: { ...DEFAULTS.from, ...(s.from || {}) },
    siteTags: { ...DEFAULTS.siteTags, ...(s.siteTags || {}) },
  };
}

async function printToken(env) {
  let t = await env.LABELS.get("print_token");
  if (!t) { t = randomToken(); await env.LABELS.put("print_token", t); }
  return t;
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]));
}

const fromReady = (s) => !!(s.from.name && s.from.street1 && s.from.city && s.from.state && s.from.zip && s.from.email && s.from.phone);

// ---------------------------------------------------------------- codes and weights
// A rule matches when the item title contains its words. "a|b" means a OR b. First match wins.
function ruleFor(title, rules) {
  const t = (title || "").toLowerCase();
  return rules.find((r) => r.match && r.match.toLowerCase().split("|").some((m) => m.trim() && t.includes(m.trim())));
}

function codesFor(lines, rules) {
  return lines.map((li) => {
    const r = ruleFor(li.title, rules);
    const code = r ? r.code : (li.title || "ITEM").split(/\s+/).slice(0, 2).join(" ").toUpperCase();
    return (li.quantity > 1 ? `${li.quantity}x ` : "") + code;
  }).join(", ");
}

// The package for an order: the biggest one any of its items needs (items with no rule use package 1).
function packageFor(lines, s) {
  const pk = s.packages;
  let best = pk[0];
  for (const li of lines) {
    const r = ruleFor(li.title, s.rules);
    const p = pk[r && Number.isInteger(r.pkg) ? r.pkg : 0] || pk[0];
    if (p.length * p.width * p.height > best.length * best.width * best.height) best = p;
  }
  return best;
}

function ouncesFor(lines, rules, fallbackOz) {
  let total = 0, known = true;
  for (const li of lines) {
    const r = ruleFor(li.title, rules);
    if (r && Number(r.oz) > 0) total += Number(r.oz) * (li.quantity || 1);
    else known = false;
  }
  return known && total > 0 ? total : fallbackOz;
}

// Store tag: built-in ones, then your own (matched ignoring case), else the first two letters.
function tagFor(app, s) {
  if (s.siteTags[app]) return s.siteTags[app];
  const own = (s.customTags || []).find((c) => c.store.toLowerCase() === app.toLowerCase());
  return own ? own.tag : app.slice(0, 2).toUpperCase();
}

function labelText(codes, siteTag) {
  return [codes, siteTag].filter(Boolean).join(" / ").replace(/[^\x20-\x7e]/g, "").slice(0, 60);
}

// ---------------------------------------------------------------- Shippo
async function shippo(path, key, body) {
  const res = await fetch(`https://api.goshippo.com${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `ShippoToken ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function shippoError(data) {
  const msgs = [];
  const walk = (v) => {
    if (!v) return;
    if (typeof v === "string") msgs.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object") { if (v.text) msgs.push(v.text); else Object.values(v).forEach(walk); }
  };
  walk(data.messages || data.detail || data);
  return msgs.slice(0, 3).join("; ");
}

// Rates the parcel, buys the cheapest allowed label, downloads the picture and queues it.
async function buyAndQueue(env, s, key, { addressTo, oz, orderId, ref, labelWords, capCents, pkg }) {
  const box = pkg || s.packages[0];
  const from = { ...s.from, country: "US" };
  const shipment = await shippo("/shipments/", key, {
    address_from: from,
    address_to: addressTo,
    parcels: [{ length: String(box.length), width: String(box.width), height: String(box.height),
                distance_unit: "in", weight: Number(oz).toFixed(2), mass_unit: "oz" }],
    async: false,
    metadata: ref,
  });
  if (!shipment.ok) return { ok: false, reason: `Shippo couldn't price this shipment: ${shippoError(shipment.data) || shipment.status}` };
  let rates = shipment.data.rates || [];
  if (s.carriers === "usps") rates = rates.filter((r) => /usps/i.test(r.provider || ""));
  if (!rates.length) {
    return { ok: false, reason: s.carriers === "usps" ? "Shippo offered no USPS rates for this address" : "Shippo offered no rates for this address" };
  }
  rates.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));
  const rate = rates[0];
  const cents = Math.round(parseFloat(rate.amount) * 100);
  const cap = capCents ?? s.capCents;
  if (cents >= cap) return { ok: false, reason: `cheapest label is $${rate.amount}, at or over your $${(cap / 100).toFixed(2)} limit` };

  const tx = await shippo("/transactions/", key, {
    rate: rate.object_id, label_file_type: "PNG", async: false, metadata: ref, ...(orderId ? { order: orderId } : {}),
  });
  if (!tx.ok || tx.data.status !== "SUCCESS" || !tx.data.label_url) {
    return { ok: false, reason: `label purchase failed: ${shippoError(tx.data) || tx.status}` };
  }
  const img = await fetch(tx.data.label_url);
  if (!img.ok) return { ok: false, reason: "label bought, but it couldn't be downloaded; print it from Shippo", tracking: tx.data.tracking_number };
  await queueJob(env, await img.arrayBuffer(), labelWords);
  return { ok: true, tracking: tx.data.tracking_number, cost: rate.amount, service: `${rate.provider} ${rate.servicelevel?.name || ""}`.trim() };
}

// ---------------------------------------------------------------- marketplace orders (via Shippo)
async function checkOrders(env) {
  const s = await getSettings(env);
  if (!s.autoBuy) return { skipped: "Auto-buy is switched off on the settings page." };
  if (!env.SHIPPO_API_KEY || exampleKey(env.SHIPPO_API_KEY)) return { skipped: "The SHIPPO_API_KEY secret is missing or still the example value." };
  if (!fromReady(s)) return { skipped: "Fill in your return address on the settings page first." };

  let since = await env.LABELS.get("orders_since");
  if (!since) { since = new Date().toISOString(); await env.LABELS.put("orders_since", since); }
  const only = s.stores.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

  const q = `/orders/?order_status[]=PAID&start_date=${encodeURIComponent(since)}&results=50`;
  const list = await shippo(q, env.SHIPPO_API_KEY);
  if (!list.ok) return { error: `Couldn't read orders from Shippo (${list.status}). Check the SHIPPO_API_KEY secret.` };

  const handled = [];
  for (const o of list.data.results || []) {
    if (handled.length >= MAX_PER_CHECK) break;
    const app = o.shop_app || "";
    if (SKIP_APPS.includes(app)) continue;
    if (only.length && !only.includes(app.toLowerCase())) continue;
    if ((o.transactions || []).length) continue;               // already has a label
    const doneKey = `order:${o.object_id}`;
    if (await env.LABELS.get(doneKey)) continue;
    await env.LABELS.put(doneKey, "buying", { expirationTtl: KEEP_ORDERS });

    const lines = (o.line_items || []).map((li) => ({ title: li.title || "", quantity: li.quantity || 1 }));
    const codes = codesFor(lines, s.rules);
    const orderOz = o.weight && /oz/i.test(o.weight_unit || "") ? Number(o.weight) : o.weight && /lb/i.test(o.weight_unit || "") ? Number(o.weight) * 16 : 0;
    const oz = ouncesFor(lines, s.rules, orderOz > 0 ? orderOz : s.defaultOz);
    const tag = s.showSite ? tagFor(app, s) : "";
    const ref = `${app || "Order"} ${o.order_number || o.object_id.slice(-8)}`;

    const r = await buyAndQueue(env, s, env.SHIPPO_API_KEY, {
      addressTo: o.to_address?.object_id || o.to_address, oz, orderId: o.object_id, ref, labelWords: labelText(codes, tag), pkg: packageFor(lines, s),
    });
    await env.LABELS.put(doneKey, JSON.stringify(r), { expirationTtl: KEEP_ORDERS });
    const entry = { at: new Date().toISOString(), order: ref, codes, ...(r.ok ? { tracking: r.tracking, cost: r.cost, service: r.service } : { held: r.reason }) };
    await logEntry(env, entry);
    handled.push(entry);
  }
  return { since, handled };
}

// ---------------------------------------------------------------- your own Stripe checkout (optional)
async function stripeHook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_API_KEY) return text("Stripe isn't set up on this Worker.", 404);
  const body = await request.text();
  if (!(await verifyStripe(body, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET))) return text("Invalid signature", 400);
  const event = JSON.parse(body);
  if (event.type !== "checkout.session.completed") return text("Ignored event");
  const session = event.data.object;
  if (session.payment_status !== "paid") return text("Not paid yet");
  const ship = session.collected_information?.shipping_details || session.shipping_details;
  if (!ship?.address) return text("No shipping address on this order");

  const doneKey = `stripe:${session.id}`;
  if (await env.LABELS.get(doneKey)) return text("Already handled");
  const s = await getSettings(env);
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session.id)}/line_items?limit=100`,
                          { headers: { Authorization: `Bearer ${env.STRIPE_API_KEY}` } });
  if (!res.ok) return text(`Stripe line items error ${res.status}`, 502);   // Stripe will retry
  const lines = ((await res.json()).data || []).map((li) => ({ title: li.description || "", quantity: li.quantity || 1 }));
  const a = ship.address;
  const addressTo = { name: ship.name, street1: a.line1, street2: a.line2 || "", city: a.city, state: a.state,
                      zip: a.postal_code, country: a.country, email: session.customer_details?.email || s.from.email };
  const ref = `Stripe ${session.id.slice(-8).toUpperCase()}`;
  const codes = codesFor(lines, s.rules);

  let r = { ok: false, reason: "Auto-buy is switched off" };
  if (s.autoBuy && env.SHIPPO_API_KEY && fromReady(s)) {
    await env.LABELS.put(doneKey, "buying", { expirationTtl: KEEP_ORDERS });
    r = await buyAndQueue(env, s, env.SHIPPO_API_KEY, {
      addressTo, oz: ouncesFor(lines, s.rules, s.defaultOz), ref, pkg: packageFor(lines, s),
      labelWords: labelText(codes, s.showSite ? s.siteTags.Stripe : ""),
    });
  }
  if (!r.ok && env.SHIPPO_API_KEY) {
    // Not bought: put the order in Shippo so you can buy the label there by hand.
    const made = await shippo("/orders/", env.SHIPPO_API_KEY, {
      order_number: ref, order_status: "PAID", placed_at: new Date().toISOString(), to_address: addressTo,
      line_items: lines.map((l) => ({ title: l.title, quantity: l.quantity })),
      weight: ouncesFor(lines, s.rules, s.defaultOz).toFixed(2), weight_unit: "oz",
    });
    if (!made.ok) { await env.LABELS.delete(doneKey); return text(`Shippo error ${made.status}`, 502); }
  }
  await env.LABELS.put(doneKey, JSON.stringify(r), { expirationTtl: KEEP_ORDERS });
  await logEntry(env, { at: new Date().toISOString(), order: ref, codes, ...(r.ok ? { tracking: r.tracking, cost: r.cost, service: r.service } : { held: r.reason }) });
  return text(r.ok ? `Label bought (${r.tracking}) and queued for printing` : `Not bought (${r.reason}); order added to Shippo`);
}

async function verifyStripe(payload, header, secret) {
  if (!header) return false;
  const t = (header.split(",").find((p) => p.startsWith("t=")) || "").slice(2);
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const want = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((x) => same(x, want));
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------------------------------------------------------------- print queue (the mailbox)
// The bridge asks GET /print/next every few seconds and confirms with POST /print/ack?id=...
async function queueJob(env, body, words) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await env.LABELS.put(`job:${id}`, body, { expirationTtl: KEEP_JOBS, metadata: { text: words || "" } });
  const q = (await env.LABELS.get("queue", "json")) || [];
  const keep = [];
  for (const j of q) if (!(await env.LABELS.get(`done:${j}`))) keep.push(j);
  keep.push(id);
  await env.LABELS.put("queue", JSON.stringify(keep.slice(-200)));
  return id;
}

async function waitingCount(env) {
  const q = (await env.LABELS.get("queue", "json")) || [];
  let n = 0;
  for (const id of q) if (!(await env.LABELS.get(`done:${id}`))) n++;
  return n;
}

async function logEntry(env, entry) {
  const log = (await env.LABELS.get("log", "json")) || [];
  log.unshift(entry);
  await env.LABELS.put("log", JSON.stringify(log.slice(0, 30)));
}

async function printRoute(request, url, env) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
  if (!token || !same(token, await printToken(env))) return text("Unauthorized", 401);

  if (url.pathname === "/print/next") {
    const takesPng = /image\/png/i.test(request.headers.get("x-bridge-accepts") || "");
    const q = (await env.LABELS.get("queue", "json")) || [];
    for (const id of q) {
      if (await env.LABELS.get(`done:${id}`)) continue;
      const { value, metadata } = await env.LABELS.getWithMetadata(`job:${id}`, { type: "arrayBuffer" });
      if (!value) continue;
      if (!takesPng) return text("Update your BTL Print Bridge to firmware 1.9.2 or newer to print labels.", 426);
      return new Response(value, { headers: { "Content-Type": "image/png", "X-Job-Id": id, "X-Label-Text": (metadata?.text || "").replace(/[^\x20-\x7e]/g, "") } });
    }
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/print/ack" && request.method === "POST") {
    const id = url.searchParams.get("id") || "";
    if (id) await env.LABELS.put(`done:${id}`, "1", { expirationTtl: KEEP_JOBS });
    return text("ok");
  }
  return text("Not found", 404);
}

// ---------------------------------------------------------------- settings page
const WHERE = "Cloudflare &rarr; Workers &amp; Pages &rarr; this Worker &rarr; Settings &rarr; Variables and Secrets";
const examplePassword = (p) => !p || p === "choose-a-password" || p.length < 8;
const exampleKey = (k) => !!k && /x{6}/i.test(k);

async function adminRoute(request, url, env) {
  if (examplePassword(env.ADMIN_PASSWORD)) return html(page("Almost there", `<p>Set your own <b>ADMIN_PASSWORD</b> secret
    (at least 8 characters, not the example one) in ${WHERE}, then reload this page.</p>`));
  if (exampleKey(env.SHIPPO_API_KEY)) return html(page("Almost there", `<p>The <b>SHIPPO_API_KEY</b> secret is still the example value.
    Replace it with your real Shippo token in ${WHERE}, then reload this page.</p>`));
  const auth = request.headers.get("authorization") || "";
  let pass = "";
  try { pass = auth.startsWith("Basic ") ? atob(auth.slice(6)).split(":").slice(1).join(":") : ""; } catch {}
  if (!same(pass, env.ADMIN_PASSWORD)) {
    return new Response("Password needed", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Label Autopilot (any username)"' } });
  }

  const back = (msg) => Response.redirect(`${url.origin}/admin?msg=${encodeURIComponent(msg)}`, 303);
  if (request.method === "POST" && url.pathname === "/admin/save") {
    const f = await request.formData();
    const old = await getSettings(env);
    const s = readForm(f, old);
    if (s.autoBuy && !old.autoBuy && !(await env.LABELS.get("orders_since"))) {
      await env.LABELS.put("orders_since", new Date().toISOString());   // never touch orders from before switching on
    }
    await env.LABELS.put("settings", JSON.stringify(s));
    return back("Saved.");
  }
  if (request.method === "POST" && url.pathname === "/admin/check") {
    const r = await checkOrders(env);
    const msg = r.skipped || r.error || (r.handled.length ? `Handled ${r.handled.length} order(s). See "Recent labels".` : "No new orders.");
    return back(msg);
  }
  if (request.method === "POST" && url.pathname === "/admin/test") {
    const s = await getSettings(env);
    if (!s.testKey) return back("Paste your Shippo TEST key (starts with shippo_test_) in the settings first.");
    if (!fromReady(s)) return back("Fill in your return address first.");
    const r = await buyAndQueue(env, s, s.testKey, {
      addressTo: { ...s.from, country: "US" }, oz: s.defaultOz, ref: "Test label",
      labelWords: labelText((s.rules[0]?.code ? `2x ${s.rules[0].code}` : "2x AB, CD"), "TEST"), capCents: 1e7,
    });
    await logEntry(env, { at: new Date().toISOString(), order: "Test label (free)", ...(r.ok ? { tracking: r.tracking, cost: r.cost, service: r.service } : { held: r.reason }) });
    return back(r.ok ? "Test label sent to the printer. It should print within a few seconds." : `Test failed: ${r.reason}`);
  }
  if (request.method === "POST" && url.pathname === "/admin/newtoken") {
    await env.LABELS.put("print_token", randomToken());
    return back("Made a new mailbox key. Copy it into your bridge's Queue token.");
  }
  if (url.pathname !== "/admin") return text("Not found", 404);

  const s = await getSettings(env);
  return html(page("Label Autopilot", settingsHtml(s, {
    latest: await latestVersion(),
    origin: url.origin, token: await printToken(env), msg: url.searchParams.get("msg") || "",
    waiting: await waitingCount(env), log: (await env.LABELS.get("log", "json")) || [],
    since: await env.LABELS.get("orders_since"), hasKey: !!env.SHIPPO_API_KEY,
    stripe: !!(env.STRIPE_WEBHOOK_SECRET && env.STRIPE_API_KEY),
  })));
}

// Newest version number published on GitHub (cached by Cloudflare for a day).
async function latestVersion() {
  try {
    const r = await fetch("https://raw.githubusercontent.com/BTLtech1/btl-label-autopilot/main/version.json", { cf: { cacheTtl: 86400 } });
    return r.ok ? String((await r.json()).version || "") : "";
  } catch { return ""; }
}
const newer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

function readPackages(g, num, old) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const l = num(`p${i}l`, 0), w = num(`p${i}w`, 0), h = num(`p${i}h`, 0);
    if (l && w && h) out.push({ name: g(`p${i}n`) || `Package ${i + 1}`, length: l, width: w, height: h });
  }
  return out.length ? out : old.packages;
}

function readForm(f, old) {
  const g = (k) => String(f.get(k) ?? "").trim();
  const num = (k, d) => { const n = parseFloat(g(k)); return Number.isFinite(n) && n > 0 ? n : d; };
  const rules = [];
  for (let i = 0; i < 40; i++) {
    const match = g(`r${i}m`), code = g(`r${i}c`).toUpperCase().replace(/[^\x20-\x7e]/g, "").slice(0, 12);
    if (match && code) rules.push({ match, code, oz: num(`r${i}o`, 0), pkg: Math.max(0, parseInt(g(`r${i}p`) || "0", 10) || 0) });
  }
  const siteTags = { ...old.siteTags };
  for (const k of Object.keys(DEFAULTS.siteTags)) { const v = g(`tag_${k}`).toUpperCase().slice(0, 4); if (v) siteTags[k] = v; }
  const customTags = [];
  for (let i = 0; i < 4; i++) {
    const store = g(`xs${i}`), tag = g(`xt${i}`).toUpperCase().replace(/[^\x20-\x7e]/g, "").slice(0, 4);
    if (store && tag) customTags.push({ store, tag });
  }
  const testKey = g("testKey");
  return {
    autoBuy: f.get("autoBuy") === "on",
    capCents: Math.round(num("cap", old.capCents / 100) * 100),
    carriers: g("carriers") === "any" ? "any" : "usps",
    packages: readPackages(g, num, old),
    defaultOz: num("defaultOz", old.defaultOz),
    from: { name: g("fname"), street1: g("fstreet1"), street2: g("fstreet2"), city: g("fcity"), state: g("fstate").toUpperCase(),
            zip: g("fzip"), email: g("femail"), phone: g("fphone") },
    stores: g("stores"),
    rules,
    showSite: f.get("showSite") === "on",
    siteTags,
    customTags,
    testKey: testKey === "(saved)" ? old.testKey : (testKey.startsWith("shippo_test_") ? testKey : ""),
  };
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function settingsHtml(s, x) {
  const field = (name, label, value, attrs = "") => `<label>${label}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
  const rows = [...s.rules, ...Array(Math.max(3, 8 - s.rules.length)).fill({ match: "", code: "", oz: "" })].map((r, i) => `
    <tr><td><input name="r${i}m" value="${esc(r.match)}" placeholder="e.g. gen 3"></td>
        <td><input name="r${i}c" value="${esc(r.code)}" placeholder="G3" class="code"></td>
        <td><input name="r${i}o" value="${esc(r.oz || "")}" placeholder="2" class="oz" inputmode="decimal"></td>
        <td><select name="r${i}p">${s.packages.map((p, j) => `<option value="${j}" ${(r.pkg || 0) === j ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></td></tr>`).join("");
  const pkgRows = [...s.packages, ...Array(Math.max(0, 4 - s.packages.length)).fill({ name: "", length: "", width: "", height: "" })].map((p, i) => `
    <tr><td><input name="p${i}n" value="${esc(p.name)}" placeholder="${i ? "e.g. Small box" : "6x9 bubble mailer"}"></td>
        <td><input name="p${i}l" value="${esc(p.length)}" class="oz" inputmode="decimal"></td>
        <td><input name="p${i}w" value="${esc(p.width)}" class="oz" inputmode="decimal"></td>
        <td><input name="p${i}h" value="${esc(p.height)}" class="oz" inputmode="decimal"></td></tr>`).join("");
  const tags = Object.keys(DEFAULTS.siteTags).map((k) => `<label class="tag">${k === "Stripe" ? "Your site (Stripe)" : k}
    <input name="tag_${k}" value="${esc(s.siteTags[k])}" maxlength="4"></label>`).join("");
  const own = [...(s.customTags || []), ...Array(Math.max(1, 4 - (s.customTags || []).length)).fill({ store: "", tag: "" })].slice(0, 4).map((c, i) => `
    <tr><td><input name="xs${i}" value="${esc(c.store)}" placeholder="e.g. Bigcommerce"></td>
        <td><input name="xt${i}" value="${esc(c.tag)}" maxlength="4" placeholder="BC" class="code"></td></tr>`).join("");
  const log = x.log.length ? x.log.slice(0, 12).map((e) => `<tr><td>${esc(new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</td>
    <td>${esc(e.order)}</td><td>${esc(e.codes || "")}</td>
    <td>${e.held ? `<span class="held">Not bought: ${esc(e.held)}</span>` : `$${esc(e.cost)} ${esc(e.service || "")}<br><small>${esc(e.tracking)}</small>`}</td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">No labels yet.</td></tr>`;
  const missing = [!x.hasKey && "the SHIPPO_API_KEY secret", !fromReady(s) && "your return address (all fields except line 2)"].filter(Boolean);

  return `
  ${x.msg ? `<p class="msg">${esc(x.msg)}</p>` : ""}
  ${x.latest && newer(x.latest, VERSION) ? `<p class="msg">Version ${esc(x.latest)} is available (you have ${VERSION}). <a href="https://github.com/BTLtech1/btl-label-autopilot#updating" style="color:inherit">How to update</a></p>` : ""}
  <section>
    <h2>Status</h2>
    <p class="big">${s.autoBuy && !missing.length ? "&#9679; On: labels are bought and printed by themselves." : "&#9675; Off: nothing is bought."}</p>
    ${missing.length ? `<p class="held">Still needed: ${missing.join(", ")}.</p>` : ""}
    <p>Waiting to print: <b>${x.waiting}</b>${x.since ? ` &middot; Handling orders placed after ${esc(new Date(x.since).toLocaleString("en-US"))}` : ""}</p>
    <div class="row">
      <form method="post" action="/admin/test"><button>Print a free test label</button></form>
      <form method="post" action="/admin/check"><button>Check for new orders now</button></form>
    </div>
    <p class="muted">New orders are checked every 15 minutes by themselves.</p>
  </section>

  <section>
    <h2>Your bridge</h2>
    <p>On your BTL Print Bridge's page, open <b>Settings</b> and paste these two into <b>Queue URL</b> and <b>Queue token</b>:</p>
    <div class="copy"><code id="qurl">${esc(x.origin)}/print</code><button type="button" onclick="cp('qurl',this)">Copy</button></div>
    <div class="copy"><code id="qtok">${esc(x.token)}</code><button type="button" onclick="cp('qtok',this)">Copy</button></div>
    <form method="post" action="/admin/newtoken" onsubmit="return confirm('Make a new key? The bridge stops printing until you paste the new one in.')"><button class="link">Make a new key</button></form>
  </section>

  <form method="post" action="/admin/save">
  <section>
    <h2>Buying labels</h2>
    <label class="check"><input type="checkbox" name="autoBuy" ${s.autoBuy ? "checked" : ""}> Buy and print labels by themselves</label>
    <p class="muted">Only orders placed after you first switch this on are touched, so old open orders never get surprise labels.</p>
    <div class="grid">
      ${field("cap", "Never spend more than ($ per label)", (s.capCents / 100).toFixed(2), 'inputmode="decimal"')}
      <label>Carrier<select name="carriers"><option value="usps" ${s.carriers === "usps" ? "selected" : ""}>USPS only</option><option value="any" ${s.carriers === "any" ? "selected" : ""}>Cheapest of any carrier</option></select></label>
    </div>
    <p class="muted">Orders whose cheapest label costs more than this wait for you in Shippo.</p>
    <h3>Packages you ship in</h3>
    <table class="rules"><tr><th>Name</th><th>Length (in)</th><th>Width (in)</th><th>Height (in)</th></tr>${pkgRows}</table>
    <p class="muted">The first one is used unless an item code below says otherwise. An order with several items goes in the biggest package any of them needs. A 6 x 9 bubble mailer is 9 x 6 x 1.</p>
    ${field("defaultOz", "Usual weight (oz)", s.defaultOz, 'inputmode="decimal"')}
    <p class="muted">Used when an item has no weight below.</p>
    ${field("stores", "Only these stores (leave blank for every store connected in Shippo)", s.stores, 'placeholder="e.g. Etsy, eBay"')}
  </section>

  <section>
    <h2>Return address</h2>
    <p class="muted">Printed on every label. Shippo needs the email and phone too.</p>
    <div class="grid">
      ${field("fname", "Name or business", s.from.name)}${field("femail", "Email", s.from.email, 'type="email"')}
      ${field("fstreet1", "Street address or PO Box", s.from.street1)}${field("fstreet2", "Apt, suite, unit or PMB (optional)", s.from.street2)}
      ${field("fcity", "City", s.from.city)}${field("fstate", "State (2 letters)", s.from.state, 'maxlength="2"')}
      ${field("fzip", "ZIP", s.from.zip)}${field("fphone", "Phone", s.from.phone, 'type="tel" placeholder="+1 555 555 5555"')}
    </div>
  </section>

  <section>
    <h2>Item codes</h2>
    <p>Short codes printed big on the label, so you know what to pack. If an item's title contains the words, it gets the code.
       Use <code>|</code> for "or" (<code>gen 1|gen 2</code>). The first match wins, so put the more specific ones on top.</p>
    <table class="rules"><tr><th>Title contains</th><th>Code</th><th>Packed oz</th><th>Package</th></tr>${rows}</table>
    <p class="muted">Save to get more empty rows. Items with no match get the first two words of their title. Add a package above to choose it here.</p>
    <label class="check"><input type="checkbox" name="showSite" ${s.showSite ? "checked" : ""}> Also print where the order came from</label>
    <div class="tags">${tags}</div>
    <h3>Other stores</h3>
    <table class="rules"><tr><th>Store name (as it shows in Recent labels)</th><th>Tag</th></tr>${own}</table>
    <p class="muted">Any other store gets the first two letters of its name.</p>
    <p class="muted">Example on the label: <b>2x G3, SD / ET</b></p>
  </section>

  <section>
    <h2>Free test labels</h2>
    <label>Shippo test key (starts with <code>shippo_test_</code>; test labels are free and can't be mailed)
      <input name="testKey" value="${s.testKey ? "(saved)" : ""}" placeholder="shippo_test_..." autocomplete="off"></label>
  </section>
  <p class="savebar"><button class="primary">Save settings</button></p>
  </form>

  <section>
    <h2>Recent labels</h2>
    <table class="log">${log}</table>
  </section>

  <section class="muted">
    <h2>Your own checkout (optional)</h2>
    <p>${x.stripe ? `Stripe is connected. Webhook address: <code>${esc(x.origin)}/stripe</code>`
      : `Sell on your own site with Stripe? Add the secrets STRIPE_WEBHOOK_SECRET and STRIPE_API_KEY and point a Stripe webhook (event <code>checkout.session.completed</code>) at <code>${esc(x.origin)}/stripe</code>. See the guide.`}</p>
  </section>
  <script>function cp(id,b){navigator.clipboard.writeText(document.getElementById(id).textContent).then(()=>{b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1500)})}</script>`;
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f4f2ee;--card:#fff;--ink:#1d1d1f;--mute:#6b6b70;--line:#e3e0da;--accent:#1f6f4a;--warn:#a4441b}
@media (prefers-color-scheme:dark){:root{--bg:#161617;--card:#212123;--ink:#f1f1f1;--mute:#a1a1a6;--line:#38383b;--accent:#5cc28f;--warn:#f08c5a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 60px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:0 0 10px}h3{font-size:15px;margin:16px 0 6px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:16px 0}
label{display:block;font-size:14px;color:var(--mute);margin:8px 0}input,select{display:block;width:100%;margin-top:4px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
label.check{display:flex;gap:10px;align-items:center;color:var(--ink);font-size:16px}label.check input{width:auto;margin:0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.grid.four{grid-template-columns:repeat(4,1fr)}@media (max-width:560px){.grid,.grid.four{grid-template-columns:1fr 1fr}}
button{font:inherit;padding:9px 14px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
button.link{border:0;background:none;color:var(--mute);text-decoration:underline;padding:4px 0}.row{display:flex;gap:10px;flex-wrap:wrap}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);vertical-align:top}.rules input{margin:0}.rules .code{max-width:90px}.rules .oz{max-width:80px}
.copy{display:flex;gap:8px;align-items:center;margin:6px 0}.copy code{flex:1;overflow-wrap:anywhere;background:var(--bg);padding:8px 10px;border-radius:8px;border:1px solid var(--line)}
.tags{display:flex;gap:10px;flex-wrap:wrap}.tag{width:110px}.muted{color:var(--mute);font-size:14px}.held{color:var(--warn)}.big{font-size:18px;font-weight:600}
.msg{background:var(--accent);color:#fff;padding:10px 14px;border-radius:10px}.savebar{position:sticky;bottom:10px;text-align:right}
code{font-size:13px}small{color:var(--mute)}
</style></head><body><main><h1>${esc(title)}</h1><p class="muted">BTL Label Autopilot ${VERSION} &middot; <a href="https://github.com/BTLtech1/btl-label-autopilot" style="color:inherit">help</a></p>${body}</main></body></html>`;
}

const text = (t, status = 200) => new Response(t, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const html = (h) => new Response(h, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
