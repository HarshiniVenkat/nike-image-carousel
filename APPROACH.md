# Nike Image Carousel — APPROACH

## What I Built

A Chrome extension that adds left/right arrow navigation directly to every product card on Nike's search and category pages, letting you cycle through up to 5 gallery images without ever clicking into the product page and back.

## Why This Problem

I shop on Nike's website regularly and the single-image product card is a constant frustration — especially for shoes, where you really want to see the side profile, sole, and on-foot shot before deciding. The fix felt obvious and self-contained: the full gallery already exists on each product page, it just takes 2 extra clicks to reach. A browser extension can eliminate those clicks entirely.

---

## Problem

On Nike's search/category pages (`nike.com/w/...`), each product card shows **only one image**. Seeing other angles (side, top, on-model, sole detail) requires clicking into the Product Display Page (PDP), looking through the gallery, and clicking back — 2 extra clicks per product when comparison-shopping. This extension adds left/right arrow navigation directly to each card, letting users cycle through up to 5 gallery images without leaving the search results.

---

## Architecture

```
Boot (document_idle on /w/* pages)
  │
  ├─ scanCards()                              ← attach arrows + dots overlay to every card
  │
  └─ setTimeout(preloadVisibleCards, 800ms)   ← let page settle, then start fetching
        │
        ├─ First 10 cards: fetch in parallel
        └─ Remaining cards: fetched sequentially with 150ms stagger

Per card:
  fetch(productUrl)
    → parse <script id="__NEXT_DATA__"> from HTML
    → walk JSON to props.pageProps.selectedProduct.contentImages
    → extract properties.portrait.url for each entry
    → rewrite t_default → t_web_pw_592_v2/f_auto (renderable size)
    → dedupe, take up to 5
    → store in imageCache, push to card via setImages()
    → preload all URLs into browser cache so clicks are instant

Arrow click:
  e.stopPropagation() / preventDefault()        ← prevent <a> from navigating
  heroImg.src = images[++idx]
  heroImg.removeAttribute('srcset')             ← critical, see gotchas
```

---

## Key Decisions

### 1. Data source: PDP `__NEXT_DATA__` (chosen)

The PDP HTML at `nike.com/t/{slug}/{styleCode}` ships a `<script id="__NEXT_DATA__" type="application/json">` containing the full product payload — including a `contentImages` array of 5-11 gallery angles per product, each with a renderable image URL.

**Why this won out:**
- Single HTTP request returns everything we need (~800KB but cacheable)
- Data is structured JSON, not scraped from rendered DOM
- Works without any Nike API authentication
- Same data Nike's own front-end uses to render the PDP, so it's complete and stable

### 2. Preload at boot, not on hover (chosen)

Cards are pre-fetched in the background after a 800ms settle delay, so by the time the user hovers, the arrows already work.

**Why:** A 300ms hover-trigger debounce + 800KB HTML fetch + image cache warm-up = 1-2 seconds of "nothing happens" when the user hovers. That felt broken. Pre-loading shifts the latency to a phase the user can't observe (idle time after page load).

### 3. Browser cache warm-up after extraction (chosen)

Right after `setImages` finalises the carousel array, we instantiate `new Image()` for each URL to force the browser to fetch and cache them. Subsequent clicks then hit cache and swap instantly.

**Why:** Without this, the first click on each new image triggered a fresh network fetch. The old image stayed displayed for 200-500ms during the load, so users perceived "the arrow does nothing" until images cached on their own. This was the single biggest UX bug we hit.

---

## Decisions Against

### `_next/data/{buildId}/t/{slug}.json` — REJECTED

Looked promising — Next.js apps usually expose page props at this endpoint. Tried it; Nike returns **404**. Their PDPs aren't part of the same Next.js build as the search pages, or the endpoint is firewalled for direct access. Unusable.

### Search page `__NEXT_DATA__` only — REJECTED

The search page's own JSON has product entries with a `colorwayImages` field, but each entry contains **one hero image per colorway** (red shoe, blue shoe), not multiple angles of the same shoe. Useless for our purpose.

### Nike's `/discover/product_details_availability/v1/.../groupKey/{groupKey}` API — REJECTED

We discovered this endpoint while reverse-engineering. It returns size + availability data (SKU codes, GTINs, stock status, age groupings) but **no image URLs at all**. There likely exists a sibling endpoint that returns images, but finding and reverse-engineering it would have required network-tab archaeology with no guarantee it works without auth headers. The PDP HTML approach was both faster to ship and more stable.

### "Enhanced Shopper Mode" toggle — REJECTED

Considered adding a top-right toggle to opt into the carousel feature (vs. always-on). Rejected because:
- The toggle pattern solves bandwidth concerns, but doesn't solve the data problem — we'd still need a working image source underneath it
- Hover-trigger preloading is already "opt-in by behavior" — users who scroll past pay nothing
- Adds UI friction and discoverability problems for a feature that should feel native

### HTML regex for `<img data-testid="Thumbnail-Img-N">` — REJECTED

The PDP is fully client-side rendered. The initial HTML contains empty `<label>` elements that JS populates with thumbnail images post-mount. Regex scraping the initial HTML finds nothing. (We left the strategy in the code as a defensive fallback in case Nike ever switches to SSR for PDPs, but it never fires.)

### Iframe rendering of PDP — REJECTED

Could have loaded the PDP in a hidden iframe, waited for hydration, then scraped the rendered DOM. Heavy (full page + all dependencies per product), slow (3-5s per PDP), and likely to trip Nike's bot detection. The static HTML fetch hits the same data source 50× faster.

### Image URL pattern guessing — REJECTED

Nike's image URLs embed unguessable UUIDs (e.g., `u_126ab356-44d8-4a06-89b4-fcdcc8df0245` for the colorway, plus a separate UUID per image). Can't construct them without already knowing them.

---

## Non-Obvious Gotchas

These each cost an iteration to find:

1. **Nike's `<img>` carries both `src` and `srcset` attributes.** Setting `src` alone doesn't change the displayed image — the browser preferentially serves from `srcset`. Must call `removeAttribute('srcset')` on every `showImage`.

2. **`__NEXT_DATA__` image URLs use `t_default` as a placeholder.** This transform doesn't render — must rewrite to `t_web_pw_592_v2/f_auto/` (the format Nike's own card grid uses) for the CDN to serve a real image.

3. **`contentImages` images are nested at `properties.portrait.url`, not flat fields.** First-pass extraction looked for `squarishURL` / `portraitURL` as direct keys and missed everything.

4. **Arrow buttons live inside an `<a>` element.** Without `e.stopPropagation()` on the click handler, the parent link intercepts and navigates to the PDP every time the user tries to cycle images.

5. **`pdpUrl` in search page JSON is an object, not a string** (`{ url, canonicalUrl, path }`). Caused a `rawUrl.startsWith is not a function` crash during the search-page-extraction phase.

---

## What Breaks First Under Pressure

1. **Nike redesigns their PDP HTML.** The entire image extraction pipeline depends on `<script id="__NEXT_DATA__">` and the `contentImages` JSON path inside it. If Nike restructures that payload, the extension silently falls back to single-image mode — no error, just no arrows.
2. **Nike rate-limits the fetches.** The current preloader fires 10 parallel requests immediately and then staggers the rest at 150ms intervals. A larger category page (60+ products) could trigger Nike's rate limiter. No backoff or retry logic is implemented.
3. **SPA navigation within Nike search.** Filtering or sorting results triggers a URL change and a DOM mutation but not a page reload — the `MutationObserver` catches new cards and enhances them, but cards that were already enhanced before the filter aren't re-fetched for the new context.
4. **`__NEXT_DATA__` size growth.** Nike's product payload is currently ~800KB per PDP. If they add more data to that blob, fetch times will increase, making the 800ms settle delay feel short.

---

## What I'd Build Next

1. **`IntersectionObserver` lazy preload** — only fetch PDPs as cards scroll into view. Would save ~70% of fetches for users who don't scroll past the first row.
2. **`chrome.storage.local` persistent cache** — cache images keyed by `groupKey` with a 7-day TTL. Repeat visits to the same category page would be instant with zero network cost.
3. **`AbortController` on in-flight fetches** — cancel preloads when the user navigates away mid-preload. Prevents wasted bandwidth on SPA navigation.
4. **Concurrent-fetch throttle** — cap parallel requests at 4 (down from 10) to reduce the risk of tripping Nike's rate limits on large category pages.
5. **Keyboard navigation** — left/right arrow keys cycle images on the currently-hovered card, making the feature usable without mouse clicks.

---

## What's Not in This Build (Deferred)

These came up during design but didn't make the cut for MVP. They're low-risk additions if the feature ships and traffic justifies them:

- **`IntersectionObserver` lazy preload** — only fetch PDPs as cards scroll into view. Would save ~70% of fetches for users who don't scroll past the first row.
- **`chrome.storage.local` persistent cache** — cache images keyed by `groupKey` with 7-day TTL. Repeat visits to the same category page become free.
- **`AbortController` on in-flight fetches** — cancel preloads when the user navigates away. Saves wasted bandwidth on SPA navigation.
- **Concurrent-fetch limit** — currently 10 parallel requests; throttling to 4 would lower the risk of tripping Nike's rate limits.

---

## File Layout

```
task2/
├── extension/
│   ├── manifest.json           ← MV3, content script on *://www.nike.com/w/*
│   ├── content/
│   │   └── content.js          ← all logic: observer, fetch, parse, carousel
│   └── styles/
│       └── carousel.css        ← arrow + dot overlay, scoped to .nc-wrap
└── APPROACH.md                 ← this file
```

No backend. No build step. No external dependencies. Load unpacked from `task2/extension/` and it works.
