// Content script - material + size badges on listing and PDP pages

const PROCESSED = new WeakSet();
let pdpInjected = false;

// --- Shared helpers ---

function parseMaterialFromNextData(str) {
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

function parseSizesFromNextData(str) {
  try {
    const data = JSON.parse(str);
    const items = findItemsInData(data);
    if (!items) return null;
    return items
      .filter(item => item.name && item.stock)
      .map(item => ({ name: item.name, inStock: item.stock !== 'no' && item.stock !== 'out_of_stock' && item.stock !== 'oos' }));
  } catch {
    return null;
  }
}

function findItemsInData(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = findItemsInData(item);
      if (result) return result;
    }
    return null;
  }
  if (obj.items && Array.isArray(obj.items) && obj.items.length > 0 && obj.items[0].name && obj.items[0].stock) {
    return obj.items;
  }
  for (const key of Object.keys(obj)) {
    const result = findItemsInData(obj[key]);
    if (result) return result;
  }
  return null;
}

function buildSizesHTML(sizes) {
  if (!sizes || !sizes.length) return '';
  return sizes.map(s => {
    const cls = s.inStock ? 'cos-size cos-size--in' : 'cos-size cos-size--out';
    return `<span class="${cls}">${s.name}</span>`;
  }).join('');
}

// --- PDP logic ---

function isPDP() {
  return window.location.pathname.includes('/product/');
}

async function injectPDPBadge() {
  if (pdpInjected) return;

  const priceEl = document.querySelector('[data-testid="product-price"]');
  if (!priceEl) return;

  const priceContainer = priceEl.closest('.flex') || priceEl.parentElement;
  if (!priceContainer?.parentElement) return;

  // Try __NEXT_DATA__ first
  let material = null;
  const script = document.getElementById('__NEXT_DATA__');
  if (script) {
    material = parseMaterialFromNextData(script.textContent);
  }

  // Fallback: fetch current URL via background
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
  priceContainer.insertAdjacentElement('afterend', badge);
}

// --- Listing logic ---

function getProductUrl(card) {
  const link = card.querySelector('a[href*="/product/"]');
  if (!link) return null;
  return new URL(link.getAttribute('href'), window.location.origin).href;
}

async function processCard(card) {
  if (PROCESSED.has(card)) return;
  PROCESSED.add(card);

  const url = getProductUrl(card);
  if (!url) return;

  // Create badge container
  const container = document.createElement('div');
  container.className = 'cos-badge-container';

  const matBadge = document.createElement('div');
  matBadge.className = 'cos-material-badge cos-material-badge--loading';
  matBadge.textContent = '⏳';
  container.appendChild(matBadge);

  const imageWrapper = card.querySelector('[data-testid="product-card-image-wrapper"]');
  const target = imageWrapper || card;
  target.style.position = 'relative';
  target.appendChild(container);

  try {
    const result = await chrome.runtime.sendMessage({ type: 'fetchProduct', url });

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
  } catch {
    matBadge.textContent = '⚠️';
    matBadge.classList.add('cos-material-badge--error');
    matBadge.classList.remove('cos-material-badge--loading');
  }
}

function scanForCards() {
  document.querySelectorAll('[data-testid="product-card-wrapper"]').forEach(processCard);
}

// --- Init ---

let lastUrl = location.href;

function run() {
  if (isPDP()) injectPDPBadge();
  scanForCards();
}

function checkNavigation() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    pdpInjected = false; // reset PDP flag on navigation
    // Small delay to let Next.js hydrate
    setTimeout(run, 500);
    setTimeout(run, 1500);
  }
}

run();

new MutationObserver(() => {
  checkNavigation();
  run();
}).observe(document.body, { childList: true, subtree: true });

// Also listen for popstate (back/forward)
window.addEventListener('popstate', () => {
  pdpInjected = false;
  setTimeout(run, 500);
});
