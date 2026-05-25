# Nike Image Carousel

Chrome extension for [nike.com](https://www.nike.com) search/category pages. Browse multiple product images on each card with arrow controls — no need to open the product page and go back.

**How it works:** On `nike.com/w/...` pages, the extension adds left/right arrows and dots to each product card. It preloads gallery images by fetching each product’s PDP HTML and extracting thumbnails from `Thumbnail-Img-*` markup or `__NEXT_DATA__`. Results are cached in memory so repeat views are instant.

## Setup

```bash
# Chrome → Extensions → Developer mode → Load unpacked → select `extension/`
```

Open any Nike category/search page (e.g. `nike.com/w/mens-shoes`). Arrows appear once a card has 2+ images loaded.

## MVP notes

- Nike-only; runs on listing pages, not the homepage.
- First load fetches PDP HTML per card (preloads first 10, then the rest in the background).
- If Nike changes their HTML/API, extraction may need an update.
