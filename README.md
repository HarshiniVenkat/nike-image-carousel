# Nike Image Carousel

Chrome extension for [nike.com](https://www.nike.com) search and category pages (`/w/*`). Cycle through up to five gallery images on each product card with arrow controls — no clicking into the PDP and back.

## Video walkthrough

[Loom — Task 2 demo](https://www.loom.com/share/a0d3ffb131844a86841229a83b786299)

## Setup

```bash
# Chrome → Extensions → Developer mode → Load unpacked → select `extension/`
```

Open any Nike category or search page (e.g. `nike.com/w/mens-shoes`). Arrows appear once a card has multiple images loaded.

No backend. No build step. No npm.

## How it works (short)

1. On load, the extension attaches arrow overlays to each product card.
2. In the background it fetches each product’s PDP HTML and reads gallery URLs from `<script id="__NEXT_DATA__">` (`contentImages`).
3. Images are cached and pre-warmed so arrow clicks feel instant.

## MVP notes

- Nike listing pages only (not the homepage).
- First visit preloads PDP data per card (first 10 in parallel, then staggered).
- If Nike changes PDP HTML or the `__NEXT_DATA__` shape, extraction may need an update.

## More detail

Architecture, rejected approaches, and gotchas: [APPROACH.md](APPROACH.md)
