// Background service worker - fetches product detail pages and extracts material + size info

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

function parseMaterial(str) {
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

function parseSizes(str) {
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

async function fetchProduct(url) {
  const resp = await fetch(url, {
    credentials: 'include',
    headers: { 'Accept': 'text/html' }
  });
  const html = await resp.text();

  const scriptMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!scriptMatch) return { error: 'No __NEXT_DATA__ found' };

  const str = scriptMatch[1];
  const material = parseMaterial(str);
  const sizes = parseSizes(str);
  return { material, sizes };
}
