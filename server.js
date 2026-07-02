const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = (process.env.CATALOG_ADMIN_TOKEN || '').trim();
const JSON_PATH = path.join(ROOT, 'catalog-data.json');
const JS_PATH = path.join(ROOT, 'catalog-data.js');
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const compareText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, {
  sensitivity: 'base',
  numeric: true,
});

const parseNumberOrNull = (value, integer = false) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const normalized = text.replace(/[,\s]/g, '');
  const number = integer ? parseInt(normalized, 10) : Number(normalized);
  return Number.isFinite(number) ? number : null;
};

const slugifyKey = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const buildCategoriesFromItems = (items) => {
  const seen = new Map();
  items.forEach((item) => {
    const key = item.categoryKey || slugifyKey(item.category);
    if (!key) return;
    const existing = seen.get(key) || {
      key,
      label: item.category || key,
      imageUrl: '',
      count: 0,
    };
    existing.count += 1;
    if (!existing.imageUrl && item.imageUrl) existing.imageUrl = item.imageUrl;
    seen.set(key, existing);
  });
  return Array.from(seen.values()).sort((a, b) => compareText(a.label, b.label) || compareText(a.key, b.key));
};

const normalizeCatalogPayload = (payload) => {
  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  const items = rawItems.map((row) => {
    const category = String(row?.category ?? '').trim();
    const itemName = String(row?.itemName ?? '').trim();
    if (!category || !itemName) return null;
    const categoryKey = String(row?.categoryKey ?? '').trim() || slugifyKey(category);
    return {
      category,
      categoryKey,
      itemName,
      price: parseNumberOrNull(row?.price),
      discountPrice: parseNumberOrNull(row?.discountPrice),
      imageUrl: String(row?.imageUrl ?? '').trim(),
      stock: parseNumberOrNull(row?.stock, true),
    };
  }).filter(Boolean).sort((a, b) => compareText(a.category, b.category) || compareText(a.itemName, b.itemName));

  const categories = Array.isArray(payload?.categories) && payload.categories.length
    ? payload.categories.map((category) => ({
        key: String(category?.key ?? '').trim(),
        label: String(category?.label ?? '').trim() || String(category?.key ?? '').trim(),
        imageUrl: String(category?.imageUrl ?? '').trim(),
        count: parseNumberOrNull(category?.count, true) ?? 0,
      })).filter((category) => category.key && category.label)
        .sort((a, b) => compareText(a.label, b.label) || compareText(a.key, b.key))
    : buildCategoriesFromItems(items);

  return { categories, items };
};

const readJsonFile = async (filePath) => {
  const text = await fs.readFile(filePath, 'utf8');
  return JSON.parse(text);
};

const readJsSnapshot = async (filePath) => {
  const text = await fs.readFile(filePath, 'utf8');
  const match = text.match(/window\.__CATALOG_DATA__\s*=\s*([\s\S]*?);\s*$/);
  if (!match) throw new Error('Could not parse catalog-data.js');
  return JSON.parse(match[1]);
};

const readCurrentCatalog = async () => {
  try {
    return normalizeCatalogPayload(await readJsonFile(JSON_PATH));
  } catch (jsonError) {
    try {
      return normalizeCatalogPayload(await readJsSnapshot(JS_PATH));
    } catch (jsError) {
      return { categories: [], items: [] };
    }
  }
};

const writeAtomically = async (filePath, content) => {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
};

const writeCatalogFiles = async (payload) => {
  const normalized = normalizeCatalogPayload(payload);
  const jsonText = `${JSON.stringify(normalized, null, 2)}\n`;
  const jsText = `window.__CATALOG_DATA__ = ${JSON.stringify(normalized, null, 2)};\n`;
  await writeAtomically(JSON_PATH, jsonText);
  await writeAtomically(JS_PATH, jsText);
  return normalized;
};

const contentTypeFor = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.csv': return 'text/csv; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.mp4': return 'video/mp4';
    default: return 'application/octet-stream';
  }
};

const sendJson = (res, statusCode, body) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body, null, 2));
};

const readRequestBody = async (req) => {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const resolveStaticPath = (pathname) => {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const target = path.normalize(path.join(ROOT, safePath));
  if (!target.startsWith(ROOT)) return null;
  return target;
};

const serveStatic = async (req, res, pathname) => {
  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    const actualPath = stat.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    const data = await fs.readFile(actualPath);
    res.writeHead(200, {
      'Content-Type': contentTypeFor(actualPath),
      'Cache-Control': actualPath.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  } catch (error) {
    if (pathname !== '/' && path.extname(pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const fallback = path.join(ROOT, 'index.html');
    const html = await fs.readFile(fallback);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(html);
  }
};

const handleApiCatalog = async (req, res) => {
  if (req.method === 'GET') {
    const catalog = await readCurrentCatalog();
    sendJson(res, 200, { catalog });
    return;
  }

  if (req.method === 'POST') {
    if (!ADMIN_TOKEN) {
      sendJson(res, 503, { error: 'CATALOG_ADMIN_TOKEN is not configured on the server.' });
      return;
    }

    const providedToken = String(req.headers['x-catalog-admin-token'] || '').trim();
    if (providedToken !== ADMIN_TOKEN) {
      sendJson(res, 403, { error: 'Invalid admin token.' });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(await readRequestBody(req));
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: 'Invalid JSON body.' });
      return;
    }

    const normalized = normalizeCatalogPayload(parsed?.payload || parsed);
    if (!normalized.items.length) {
      sendJson(res, 400, { error: 'No valid catalog items were provided.' });
      return;
    }

    const catalog = await writeCatalogFiles(normalized);
    sendJson(res, 200, {
      ok: true,
      saved: catalog.items.length,
      catalog,
    });
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed.' });
};

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (requestUrl.pathname === '/api/catalog') {
      await handleApiCatalog(req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }

    await serveStatic(req, res, requestUrl.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error.' });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`Maa Mangla shop server running on http://localhost:${PORT}`);
  if (ADMIN_TOKEN) {
    console.log('Catalog writes are protected by CATALOG_ADMIN_TOKEN.');
  } else {
    console.log('Set CATALOG_ADMIN_TOKEN to enable catalog writes.');
  }
});
