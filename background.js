// Background service worker - fetches product pages and extracts material + size info
// Supports COS and Uniqlo

const cache = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'fetchProduct') return;

  const { url } = msg;

  if (cache.has(url)) {
    sendResponse(cache.get(url));
    return;
  }

  fetchProduct(url).then(result => {
    cache.set(url, result);
    sendResponse(result);
  }).catch(err => {
    sendResponse({ error: err.message });
  });

  return true;
});

// ─── Site detection ───

function detectSite(url) {
  if (url.includes('cos.com')) return 'cos';
  if (url.includes('arket.com')) return 'arket';
  if (url.includes('uniqlo.com')) return 'uniqlo';
  return null;
}

async function fetchProduct(url) {
  const site = detectSite(url);
  if (site === 'cos') return fetchCOS(url);
  if (site === 'arket') return fetchCOS(url); // Same H&M Group Next.js structure
  if (site === 'uniqlo') return fetchUniqlo(url);
  return { error: 'Unknown site' };
}

// ─── COS ───

function cosParseMaterial(str) {
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

function cosParseSizes(str) {
  try {
    const data = JSON.parse(str);
    const items = findItems(data);
    if (!items) return null;
    return items
      .filter(item => item.name && item.stock)
      .map(item => ({
        name: item.name,
        inStock: item.stock !== 'no' && item.stock !== 'out_of_stock' && item.stock !== 'oos'
      }));
  } catch {
    return null;
  }
}

function findItems(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = findItems(item);
      if (result) return result;
    }
    return null;
  }
  if (obj.items && Array.isArray(obj.items) && obj.items.length > 0 && obj.items[0].name && obj.items[0].stock) {
    return obj.items;
  }
  for (const key of Object.keys(obj)) {
    const result = findItems(obj[key]);
    if (result) return result;
  }
  return null;
}

async function fetchCOS(url) {
  const resp = await fetch(url, { credentials: 'include', headers: { 'Accept': 'text/html' } });
  const html = await resp.text();

  const scriptMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!scriptMatch) return { error: 'No __NEXT_DATA__ found' };

  const str = scriptMatch[1];
  const material = cosParseMaterial(str);
  const sizes = cosParseSizes(str);
  return { material, sizes };
}

// ─── Uniqlo ───

// Clean up verbose Uniqlo composition strings
// Input: "Dieser Artikel wird mit einer der folgenden Optionen geliefert...<br>456675: Körper: 47% Polyester..."
// Output: "Körper: 47% Polyester, 42% Polyester, 11% Elasthan · Taille: 90% Nylon, 10% Elasthan"
function cleanUniqloComposition(raw) {
  if (!raw) return null;

  // Strip HTML tags
  let text = raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

  // Remove preamble (everything before first percentage pattern, but keep part labels like "Körper:")
  // Split by newlines, find lines with actual percentages
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const matLines = lines.filter(l => /\d+%/.test(l));

  if (!matLines.length) return text; // fallback to raw

  // Take the first variant only (they're usually near-identical)
  let line = matLines[0];

  // Strip leading article numbers like "456675: " or "454326, 482536: "
  line = line.replace(/^[\d,\s]+:\s*/, '');

  // Replace "/" separators with " · " for readability
  line = line.replace(/\s*\/\s*/g, ' · ');

  // Clean up "Recycelte Fasern" etc — keep it, it's useful info
  // Collapse multiple spaces
  line = line.replace(/\s+/g, ' ').trim();

  return line;
}

// Extract locale info from URL: /de/de/products/... → { country: 'de', lang: 'de' }
function uniqloParseUrl(url) {
  const m = url.match(/uniqlo\.com\/(\w+)\/(\w+)\/products\/(E\d+-\d+)\/(\d+)/);
  if (!m) return null;
  return { country: m[1], lang: m[2], productId: m[3], priceGroup: m[4] };
}

// Known client IDs per country (found in Uniqlo's main JS bundle)
const UNIQLO_CLIENT_IDS = {
  de: 'uq.de.web-spa',
  uk: 'uq.uk.web-spa',
  fr: 'uq.fr.web-spa',
  eu: 'uq.eu.web-spa',
};

function uniqloClientId(country) {
  return UNIQLO_CLIENT_IDS[country] || `uq.${country}.web-spa`;
}

// Strategy 1: Fetch product page HTML → parse __PRELOADED_STATE__ for composition + sizes
function uniqloParsePreloadedState(html) {
  const idx = html.indexOf('__PRELOADED_STATE__ = ');
  if (idx < 0) return null;
  const start = idx + '__PRELOADED_STATE__ = '.length;
  const end = html.indexOf('</script>', start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.substring(start, end).trimEnd().replace(/;$/, ''));
  } catch {
    return null;
  }
}

function uniqloExtractProduct(state) {
  const pdpEntity = state?.entity?.pdpEntity;
  if (!pdpEntity) return null;
  for (const key of Object.keys(pdpEntity)) {
    if (pdpEntity[key]?.product) return pdpEntity[key].product;
  }
  return null;
}

// Strategy 2: Fetch stock from l2s API (needs client ID header)
async function uniqloFetchStock(country, lang, productId, priceGroup, sizes) {
  try {
    const apiUrl = `https://www.uniqlo.com/${country}/api/commerce/v5/${lang}/products/${productId}/price-groups/${priceGroup}/l2s?withPrices=true&withStocks=true&httpFailure=true`;
    const resp = await fetch(apiUrl, {
      headers: {
        'x-fr-clientid': uniqloClientId(country),
        'Accept': 'application/json'
      }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.status !== 'ok' || !data.result?.l2s) return null;

    // A size is in stock if ANY color variant has sales=true
    const sizeStock = {};
    for (const l2 of data.result.l2s) {
      const dc = l2.size?.displayCode;
      if (!dc) continue;
      if (!sizeStock[dc]) sizeStock[dc] = false;
      if (l2.sales) sizeStock[dc] = true;
    }

    return sizes
      .filter(s => s.display?.showFlag !== false)
      .map(s => ({
        name: s.name,
        inStock: sizeStock[s.displayCode] ?? false
      }));
  } catch {
    return null;
  }
}

async function fetchUniqlo(url) {
  const parsed = uniqloParseUrl(url);
  if (!parsed) return { error: 'Cannot parse Uniqlo URL' };

  // Fetch product page HTML for composition (only source of material data)
  const resp = await fetch(url, { credentials: 'include', headers: { 'Accept': 'text/html' } });
  const html = await resp.text();

  const state = uniqloParsePreloadedState(html);
  if (!state) return { error: 'No __PRELOADED_STATE__ found' };

  const product = uniqloExtractProduct(state);
  if (!product) return { error: 'No product in state' };

  const material = cleanUniqloComposition(product.composition) || null;

  // Fetch stock from API (parallel-safe, uses known client ID)
  let sizes = null;
  if (product.sizes?.length) {
    sizes = await uniqloFetchStock(
      parsed.country, parsed.lang,
      parsed.productId, parsed.priceGroup,
      product.sizes
    );
  }

  return { material, sizes };
}
