// Content script - material + size badges on listing and PDP pages
// Supports COS and Uniqlo - auto-detects based on hostname

const PROCESSED = new WeakSet();
let pdpInjected = false;

const SITE = detectSite();

function detectSite() {
  const host = location.hostname;
  if (host.includes('cos.com')) return 'cos';
  if (host.includes('uniqlo.com')) return 'uniqlo';
  return null;
}

// ─── Shared helpers ───

function buildSizesHTML(sizes) {
  if (!sizes || !sizes.length) return '';
  return sizes.map(s => {
    const cls = s.inStock ? 'cos-size cos-size--in' : 'cos-size cos-size--out';
    return `<span class="${cls}">${s.name}</span>`;
  }).join('');
}

function createBadgeContainer() {
  const container = document.createElement('div');
  container.className = 'cos-badge-container';
  return container;
}

function createLoadingBadge() {
  const badge = document.createElement('div');
  badge.className = 'cos-material-badge cos-material-badge--loading';
  badge.textContent = '⏳';
  return badge;
}

function updateBadgeWithResult(matBadge, container, result) {
  if (result?.material) {
    matBadge.textContent = result.material;
    matBadge.classList.remove('cos-material-badge--loading');
  } else {
    matBadge.textContent = '—';
    matBadge.classList.add('cos-material-badge--error');
    matBadge.classList.remove('cos-material-badge--loading');
  }

  if (result?.sizes?.length) {
    const sizeBadge = document.createElement('div');
    sizeBadge.className = 'cos-size-badge';
    sizeBadge.innerHTML = buildSizesHTML(result.sizes);
    container.appendChild(sizeBadge);
  }
}

function markError(matBadge) {
  matBadge.textContent = '⚠️';
  matBadge.classList.add('cos-material-badge--error');
  matBadge.classList.remove('cos-material-badge--loading');
}

// ─── COS: PDP ───

function cosParseMaterialFromNextData(str) {
  const match = str.match(/"var_material_composition_desc":"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  try {
    const compJson = JSON.parse(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    const parts = [];
    for (const group of compJson) {
      const prefix = compJson.length > 1 ? `${group.type}: ` : '';
      const mats = group.materials.map(m => `${m.percentage}% ${m.material}`).join(', ');
      parts.push(prefix + mats);
    }
    return parts.join(' · ');
  } catch {
    return null;
  }
}

function cosIsPDP() {
  return location.pathname.includes('/product/');
}

async function cosInjectPDPBadge() {
  if (pdpInjected) return;

  // Find the product info area — try multiple anchors
  const priceEl = document.querySelector('[data-testid="product-price"]');
  if (!priceEl) return;

  const priceContainer = priceEl.closest('.flex') || priceEl.parentElement;
  if (!priceContainer?.parentElement) return;

  let material = null;
  const script = document.getElementById('__NEXT_DATA__');
  if (script) material = cosParseMaterialFromNextData(script.textContent);

  if (!material) {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'fetchProduct', url: location.href });
      material = result?.material;
    } catch {}
  }

  if (!material) return;

  pdpInjected = true;
  const badge = document.createElement('div');
  badge.className = 'cos-material-badge cos-material-badge--pdp';
  badge.textContent = material;

  // Inject right after price so it's visible without scrolling
  priceContainer.insertAdjacentElement('afterend', badge);

  // Also inject at the very top of the product info column (before product name)
  // so it's the first thing you see
  const productName = document.querySelector('[data-testid="product-name"], h1');
  if (productName && productName !== priceContainer) {
    const topBadge = badge.cloneNode(true);
    topBadge.className = 'cos-material-badge cos-material-badge--pdp-top';
    productName.insertAdjacentElement('afterend', topBadge);
  }
}

function cosGetProductUrl(card) {
  const link = card.querySelector('a[href*="/product/"]');
  if (!link) return null;
  return new URL(link.getAttribute('href'), location.origin).href;
}

async function cosProcessCard(card) {
  if (PROCESSED.has(card)) return;
  PROCESSED.add(card);

  const url = cosGetProductUrl(card);
  if (!url) return;

  const container = createBadgeContainer();
  const matBadge = createLoadingBadge();
  container.appendChild(matBadge);

  const imageWrapper = card.querySelector('[data-testid="product-card-image-wrapper"]');
  const target = imageWrapper || card;
  target.style.position = 'relative';
  target.appendChild(container);

  try {
    const result = await chrome.runtime.sendMessage({ type: 'fetchProduct', url });
    updateBadgeWithResult(matBadge, container, result);
  } catch {
    markError(matBadge);
  }
}

function cosScanForCards() {
  document.querySelectorAll('[data-testid="product-card-wrapper"]').forEach(cosProcessCard);
}

// ─── Uniqlo: PDP ───

function uniqloIsPDP() {
  return /\/products\/E\d+-\d+\/\d+/.test(location.pathname);
}

async function uniqloInjectPDPBadge() {
  if (pdpInjected) return;

  // Product name is a div with data-testid="ITOTypography" and font-size-18
  const nameEl = document.querySelector('[data-testid="ITOTypography"].ito-font-size-18');
  const priceEl = document.querySelector('.pdp-product-price, [class*="product-price"], .price-text');
  const anchor = nameEl || priceEl || document.querySelector('h1');
  if (!anchor) return;

  // Try to get composition from __PRELOADED_STATE__ in the page
  let material = null;
  const scripts = document.querySelectorAll('script:not([src])');
  for (const s of scripts) {
    if (s.textContent.includes('__PRELOADED_STATE__')) {
      const match = s.textContent.match(/"composition"\s*:\s*"([^"]+)"/);
      if (match) {
        material = match[1];
        break;
      }
    }
  }

  // Fallback: fetch via background
  if (!material) {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'fetchProduct', url: location.href });
      material = result?.material;
    } catch {}
  }

  if (!material) return;

  pdpInjected = true;
  const badge = document.createElement('div');
  badge.className = 'cos-material-badge cos-material-badge--pdp-top';
  badge.textContent = material;
  anchor.insertAdjacentElement('afterend', badge);
}

// ─── Uniqlo: Listing ───

function uniqloGetProductUrl(card) {
  // card is an <a> with href to /products/...
  const href = card.getAttribute('href') || card.href;
  if (!href) return null;
  return new URL(href, location.origin).href;
}

async function uniqloProcessCard(card) {
  if (PROCESSED.has(card)) return;
  PROCESSED.add(card);

  const url = uniqloGetProductUrl(card);
  if (!url) return;

  const container = createBadgeContainer();
  const matBadge = createLoadingBadge();
  container.appendChild(matBadge);

  // Place badge on the image carousel wrapper
  const imageWrapper = card.querySelector('.product-tile__carousel-wrapper');
  const target = imageWrapper || card.querySelector('.product-tile') || card;
  target.style.position = 'relative';
  target.appendChild(container);

  try {
    const result = await chrome.runtime.sendMessage({ type: 'fetchProduct', url });
    updateBadgeWithResult(matBadge, container, result);
  } catch {
    markError(matBadge);
  }
}

function uniqloScanForCards() {
  document.querySelectorAll('a.product-tile__link').forEach(uniqloProcessCard);
}

// ─── Init ───

let lastUrl = location.href;

function run() {
  if (SITE === 'cos') {
    if (cosIsPDP()) cosInjectPDPBadge();
    cosScanForCards();
  } else if (SITE === 'uniqlo') {
    if (uniqloIsPDP()) uniqloInjectPDPBadge();
    uniqloScanForCards();
  }
}

function checkNavigation() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    pdpInjected = false;
    setTimeout(run, 500);
    setTimeout(run, 1500);
  }
}

run();

new MutationObserver(() => {
  checkNavigation();
  run();
}).observe(document.body, { childList: true, subtree: true });

window.addEventListener('popstate', () => {
  pdpInjected = false;
  setTimeout(run, 500);
});
