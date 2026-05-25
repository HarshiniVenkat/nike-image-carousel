(() => {
  // ── State ──────────────────────────────────────────────────────────────────
  const imageCache    = new Map();   // productUrl → string[] (empty array = checked, no images)
  const fetchPromises = new Map();   // productUrl → in-flight Promise (dedup concurrent calls)
  const enhanced      = new WeakSet();
  const cardRefs      = new WeakMap(); // card → { setImages, productUrl }

  // ── Boot ───────────────────────────────────────────────────────────────────
  scanCards();

  // Kick off preload after a short delay so the page settles first
  let preloadTimer = setTimeout(preloadVisibleCards, 800);

  const observer = new MutationObserver(() => {
    scanCards();
    // When new cards appear (infinite scroll / SPA nav), re-trigger preload
    clearTimeout(preloadTimer);
    preloadTimer = setTimeout(preloadVisibleCards, 800);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ── Scan / enhance cards ──────────────────────────────────────────────────
  function scanCards() {
    document.querySelectorAll(
      '.product-grid__card, [data-testid="product-card"]'
    ).forEach(enhanceCard);
  }

  function enhanceCard(card) {
    if (enhanced.has(card)) return;
    enhanced.add(card);

    const link = card.querySelector('a[href*="/t/"]') || card.querySelector('a');
    if (!link) return;

    const productUrl = link.href;
    const heroImg    = card.querySelector('img');
    if (!heroImg) return;

    // Wrap image in positioning context for overlay
    const wrap = document.createElement('div');
    wrap.className = 'nc-wrap';
    heroImg.parentElement.insertBefore(wrap, heroImg);
    wrap.appendChild(heroImg);

    wrap.insertAdjacentHTML('beforeend', `
      <button class="nc-arrow nc-arrow--left"  aria-label="Previous image">&#8249;</button>
      <button class="nc-arrow nc-arrow--right" aria-label="Next image">&#8250;</button>
      <div class="nc-dots"></div>
    `);

    const leftBtn  = wrap.querySelector('.nc-arrow--left');
    const rightBtn = wrap.querySelector('.nc-arrow--right');
    const dotsEl   = wrap.querySelector('.nc-dots');

    let images = [heroImg.src];
    let idx    = 0;

    function showImage(newIdx) {
      idx = (newIdx + images.length) % images.length;
      const newSrc = images[idx];
      console.log('[Nike Carousel] showImage idx=', idx, '→', newSrc);
      heroImg.src = newSrc;
      // Also clear srcset — otherwise the browser may pick a different image based on viewport
      heroImg.removeAttribute('srcset');
      dotsEl.querySelectorAll('.nc-dot').forEach((d, i) =>
        d.classList.toggle('nc-dot--active', i === idx)
      );
    }

    function buildDots() {
      dotsEl.innerHTML = images
        .map((_, i) => `<span class="nc-dot${i === 0 ? ' nc-dot--active' : ''}"></span>`)
        .join('');
    }

    function setImages(newImages) {
      if (!newImages || newImages.length < 2) return;
      // Keep the original hero image as image[0] so the card looks identical until clicked.
      // Deduplicate aggressively — Nike sometimes repeats the same image in contentImages.
      const combined = dedupe([heroImg.src, ...newImages]);
      if (combined.length < 2) return; // all dupes — no point showing a carousel
      images = combined.slice(0, 5);
      idx = 0;
      buildDots();

      // Warm the browser image cache so subsequent clicks are instant.
      // Without this, the first click on each new image triggers a fetch and
      // the user sees the old image hanging around for 200-500ms.
      images.slice(1).forEach(url => { new Image().src = url; });
    }

    cardRefs.set(card, { setImages, productUrl });

    // If preload already finished for this URL, apply immediately
    if (imageCache.has(productUrl)) {
      setImages(imageCache.get(productUrl));
    }

    leftBtn.addEventListener('click', e => {
      e.stopPropagation(); e.preventDefault();
      console.log('[Nike Carousel] ← click, length:', images.length, 'idx:', idx);
      if (images.length > 1) showImage(idx - 1);
    });
    rightBtn.addEventListener('click', e => {
      e.stopPropagation(); e.preventDefault();
      console.log('[Nike Carousel] → click, length:', images.length, 'idx:', idx);
      if (images.length > 1) showImage(idx + 1);
    });

    // Fallback: if user hovers before preload reaches this card, fetch on demand
    let hoverTimer;
    wrap.addEventListener('mouseenter', () => {
      if (images.length > 1) return;
      hoverTimer = setTimeout(async () => {
        const fetched = await loadImages(productUrl);
        setImages(fetched);
      }, 200);
    });
    wrap.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
  }

  // ── Preload: first 10 in parallel, rest in background (throttled) ─────────
  async function preloadVisibleCards() {
    const cards = Array.from(document.querySelectorAll(
      '.product-grid__card, [data-testid="product-card"]'
    ));
    const tasks = cards
      .map(card => {
        const ref = cardRefs.get(card);
        return ref && !imageCache.has(ref.productUrl) ? { card, url: ref.productUrl } : null;
      })
      .filter(Boolean);

    if (!tasks.length) return;
    console.log(`[Nike Carousel] preloading ${tasks.length} cards (first 10 priority)`);

    // First 10 in parallel
    const priority = tasks.slice(0, 10);
    await Promise.all(priority.map(({ card, url }) => preloadCard(card, url)));
    console.log('[Nike Carousel] priority preload complete');

    // Rest in background, staggered to avoid hammering Nike
    const background = tasks.slice(10);
    for (let i = 0; i < background.length; i++) {
      const { card, url } = background[i];
      preloadCard(card, url); // fire and forget
      await sleep(150);
    }
    console.log('[Nike Carousel] background preload queued');
  }

  async function preloadCard(card, url) {
    const images = await loadImages(url);
    const ref = cardRefs.get(card);
    if (ref) ref.setImages(images);
  }

  // ── Image loading: fetch PDP HTML, extract <img data-testid="Thumbnail-Img-N"> ──
  function loadImages(productUrl) {
    if (imageCache.has(productUrl))    return Promise.resolve(imageCache.get(productUrl));
    if (fetchPromises.has(productUrl)) return fetchPromises.get(productUrl);

    const promise = (async () => {
      try {
        const res = await fetchWithTimeout(productUrl, 8000);
        if (!res.ok) {
          console.log(`[Nike Carousel] ${shortUrl(productUrl)} → HTTP ${res.status}`);
          imageCache.set(productUrl, []);
          return [];
        }
        const html = await res.text();

        // Strategy 1: extract <img data-testid="Thumbnail-Img-N" src="...">
        let images = extractThumbnails(html);
        if (images.length >= 2) {
          console.log(`[Nike Carousel] ${shortUrl(productUrl)} → ${images.length} thumbnails`);
          imageCache.set(productUrl, images);
          return images;
        }

        // Strategy 2: fall back to __NEXT_DATA__ in the PDP HTML
        const nd = parseNextData(html);
        if (nd) {
          const fromData = findImagesInJson(nd);
          if (fromData.length >= 2) {
            const result = dedupe(fromData).slice(0, 5);
            console.log(`[Nike Carousel] ${shortUrl(productUrl)} → ${result.length} from __NEXT_DATA__`);
            imageCache.set(productUrl, result);
            return result;
          }
        }

        // Strategy 3: any Nike PDP image URL we can find (last resort)
        images = scrapeAllPdpImages(html);
        if (images.length >= 2) {
          console.log(`[Nike Carousel] ${shortUrl(productUrl)} → ${images.length} via PDP scrape`);
          imageCache.set(productUrl, images);
          return images;
        }

        // Diagnostics so we can see why a card failed
        console.log(`[Nike Carousel] ${shortUrl(productUrl)} → no images found`,
          { len: html.length,
            hasThumbnail: html.includes('Thumbnail-Img-'),
            hasNextData:  html.includes('__NEXT_DATA__') });
        imageCache.set(productUrl, []);
        return [];
      } catch (e) {
        console.log(`[Nike Carousel] ${shortUrl(productUrl)} error:`, e.message);
        imageCache.set(productUrl, []);
        return [];
      } finally {
        fetchPromises.delete(productUrl);
      }
    })();

    fetchPromises.set(productUrl, promise);
    return promise;
  }

  // ── Extractors ────────────────────────────────────────────────────────────
  // Find every <img ... data-testid="Thumbnail-Img-N" ... src="...">
  function extractThumbnails(html) {
    const results = [];
    const imgRegex = /<img\b[^>]*>/g;
    let m;
    while ((m = imgRegex.exec(html)) !== null) {
      const tag = m[0];
      if (!/data-testid="Thumbnail-Img-\d+"/.test(tag)) continue;
      const srcMatch = tag.match(/\bsrc="([^"]+)"/);
      if (!srcMatch) continue;
      const url = srcMatch[1];
      if (!isNikeImg(url)) continue;
      // Thumbnails are t_PDP_144_v1; upgrade to a larger size for the carousel
      const upgraded = url.replace(/\/t_PDP_\d+_v\d+\//, '/t_PDP_936_v1/');
      results.push(upgraded);
    }
    return dedupe(results).slice(0, 5);
  }

  // Inline __NEXT_DATA__ in the PDP HTML
  function parseNextData(html) {
    const marker = '<script id="__NEXT_DATA__"';
    const start  = html.indexOf(marker);
    if (start === -1) return null;
    const contentStart = html.indexOf('>', start) + 1;
    const contentEnd   = html.indexOf('</script>', contentStart);
    if (contentEnd === -1) return null;
    try { return JSON.parse(html.slice(contentStart, contentEnd)); } catch { return null; }
  }

  // Walk Nike's JSON tree for arrays of image URLs
  function findImagesInJson(obj, depth = 0) {
    if (depth > 14 || obj == null || typeof obj !== 'object') return [];

    // Fast path: PDP __NEXT_DATA__ shape — props.pageProps.selectedProduct.contentImages
    const fastPath = obj?.props?.pageProps?.selectedProduct?.contentImages
                  || obj?.pageProps?.selectedProduct?.contentImages
                  || obj?.selectedProduct?.contentImages;
    if (Array.isArray(fastPath) && fastPath.length >= 2) {
      const urls = fastPath
        .map(img => img?.properties?.portrait?.url || img?.properties?.squarish?.url)
        .filter(u => isNikeImg(u))
        .map(upgradeNikeImage);
      if (urls.length >= 2) return urls;
    }

    if (Array.isArray(obj)) {
      const urls = obj.flatMap(v => {
        if (typeof v === 'string' && isNikeImg(v)) return [v];
        if (v && typeof v === 'object') {
          // Nike PDP contentImages shape: { properties: { portrait: { url }, squarish: { url } } }
          const nested = v.properties?.portrait?.url || v.properties?.squarish?.url;
          if (nested && isNikeImg(nested)) return [nested];
          // Flat shape: { squarishURL: '...', portraitURL: '...', url: '...' }
          for (const k of ['squarishURL', 'portraitURL', 'url', 'src', 'imageUrl']) {
            if (v[k] && isNikeImg(v[k])) return [v[k]];
          }
        }
        return [];
      });
      if (urls.length >= 2) return urls.map(upgradeNikeImage);
    }
    for (const val of Object.values(obj)) {
      const result = findImagesInJson(val, depth + 1);
      if (result.length >= 2) return result;
    }
    return [];
  }

  // Nike's __NEXT_DATA__ has t_default URLs that don't render — swap to
  // t_web_pw_592_v2/f_auto (exact format Nike's own product cards use).
  function upgradeNikeImage(url) {
    return url
      .replace(/\/t_default\//, '/t_web_pw_592_v2/f_auto/')
      .replace(/\/t_PDP_\d+_v\d+\//, '/t_PDP_936_v1/');
  }

  // Last resort: any t_PDP_* CDN URL in the HTML
  function scrapeAllPdpImages(html) {
    const regex = /https:\/\/static\.nike\.com\/[^\s"'<>]+t_PDP_\d+_v\d+\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp)/gi;
    const found = html.match(regex) || [];
    return dedupe(found.map(u => u.replace(/\/t_PDP_\d+_v\d+\//, '/t_PDP_936_v1/'))).slice(0, 5);
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  function fetchWithTimeout(url, ms) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal, credentials: 'include' })
      .finally(() => clearTimeout(timer));
  }

  function isNikeImg(url) {
    return typeof url === 'string' &&
      (url.includes('static.nike.com') || url.includes('s3.nikecdn.com'));
  }

  function dedupe(arr) { return [...new Set(arr)]; }
  function sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }
  function shortUrl(u) { return u.split('/').slice(-2).join('/'); }
})();
