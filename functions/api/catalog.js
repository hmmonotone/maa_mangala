import { normalizeCatalogPayload, readCatalogSource } from '../_shared/catalog.js';

const STORAGE_KEY = 'catalog-data';

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body, null, 2), {
  ...init,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(init.headers || {}),
  },
});

const writeCatalog = async (env, payload) => {
  const normalized = normalizeCatalogPayload(payload);
  if (!normalized.items.length) {
    throw new Error('No valid catalog items were provided.');
  }

  if (!env?.CATALOG_STORE?.put) {
    throw new Error('CATALOG_STORE binding is not configured.');
  }

  await env.CATALOG_STORE.put(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
};

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'GET') {
    const catalog = await readCatalogSource(request, env);
    return jsonResponse({ catalog });
  }

  if (request.method === 'POST') {
    const token = String(request.headers.get('X-Catalog-Admin-Token') || '').trim();
    const adminToken = String(env?.CATALOG_ADMIN_TOKEN || '').trim();

    if (!adminToken) {
      return jsonResponse({ error: 'CATALOG_ADMIN_TOKEN is not configured.' }, { status: 503 });
    }
    if (token !== adminToken) {
      return jsonResponse({ error: 'Invalid admin token.' }, { status: 403 });
    }

    let body;
    try {
      body = await request.json();
    } catch (error) {
      return jsonResponse({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    try {
      const normalized = await writeCatalog(env, body?.payload || body);
      return jsonResponse({
        ok: true,
        saved: normalized.items.length,
        catalog: normalized,
      });
    } catch (error) {
      return jsonResponse({ error: error?.message || 'Unable to save catalog.' }, { status: 400 });
    }
  }

  return jsonResponse({ error: 'Method not allowed.' }, { status: 405 });
}
