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

const readCatalogSource = async (request, env) => {
  if (env?.CATALOG_STORE?.get) {
    const stored = await env.CATALOG_STORE.get('catalog-data');
    if (stored) {
      try {
        return normalizeCatalogPayload(JSON.parse(stored));
      } catch (error) {
        console.warn('Stored catalog could not be parsed', error);
      }
    }
  }

  const assetResponse = await fetch(new URL('/catalog-data.json', request.url), { cf: { cacheTtl: 0 } });
  if (assetResponse.ok) {
    try {
      return normalizeCatalogPayload(await assetResponse.json());
    } catch (error) {
      console.warn('Bundled catalog-data.json could not be parsed', error);
    }
  }

  return { categories: [], items: [] };
};

const renderUploadPage = () => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Upload Product Catalog</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/xlsx/dist/xlsx.full.min.js"></script>
</head>
<body class="min-h-screen bg-slate-950 text-white">
  <main class="mx-auto flex min-h-screen max-w-4xl items-center px-4 py-10">
    <section class="w-full rounded-[2rem] border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur">
      <div class="flex items-start justify-between gap-6">
        <div>
          <p class="text-xs font-bold uppercase tracking-[0.3em] text-amber-300">Staff upload</p>
          <h1 class="mt-2 text-3xl font-black">Upload product CSV or Excel</h1>
          <p class="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            Drop a CSV or Excel file, map rows by category, and save the live catalog.
          </p>
        </div>
        <a href="/" class="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10">Back to site</a>
      </div>

      <div class="mt-6 grid gap-4 lg:grid-cols-[1fr_0.8fr]">
        <div class="rounded-[1.5rem] border border-white/10 bg-slate-900/70 p-4">
          <label id="dropZone" class="block cursor-pointer rounded-[1.4rem] border-2 border-dashed border-white/15 bg-white/5 p-8 text-center transition hover:border-amber-300 hover:bg-white/10">
            <input id="fileInput" type="file" accept=".csv,.xlsx,.xls" class="hidden" />
            <p class="text-lg font-bold">Drop file here or choose one</p>
            <p class="mt-2 text-sm text-slate-300">Expected columns: category, categoryKey, itemName, price, discountPrice, imageUrl, stock</p>
          </label>

          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <input id="tokenInput" type="password" placeholder="Admin token" class="h-12 rounded-2xl border border-white/10 bg-slate-950 px-4 text-sm outline-none placeholder:text-slate-500" />
            <button id="saveBtn" class="h-12 rounded-2xl bg-amber-400 px-5 text-sm font-bold text-slate-950 transition hover:bg-amber-300">Save catalog</button>
          </div>

          <p id="fileName" class="mt-4 text-sm text-slate-300">No file selected.</p>
          <p id="status" class="mt-2 text-sm text-emerald-300"></p>
          <p id="error" class="mt-2 text-sm text-rose-300"></p>
        </div>

        <div class="rounded-[1.5rem] border border-white/10 bg-white/5 p-4 text-sm leading-6 text-slate-200">
          <p class="text-xs font-bold uppercase tracking-[0.3em] text-slate-400">How it works</p>
          <ul class="mt-3 space-y-2">
            <li>1. Upload CSV or Excel.</li>
            <li>2. Rows are normalized and grouped by category automatically.</li>
            <li>3. The live catalog is stored in Cloudflare and the site reloads from it.</li>
          </ul>
          <p class="mt-4 text-xs text-slate-400">If the server token is missing or wrong, the save is rejected.</p>
        </div>
      </div>
    </section>
  </main>

  <script>
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const tokenInput = document.getElementById('tokenInput');
    const saveBtn = document.getElementById('saveBtn');
    const fileName = document.getElementById('fileName');
    const status = document.getElementById('status');
    const error = document.getElementById('error');
    let selectedFile = null;

    const setStatus = (value) => { status.textContent = value || ''; };
    const setError = (value) => { error.textContent = value || ''; };

    const readRows = async (file) => {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      let workbook;
      if (ext === 'csv') {
        workbook = XLSX.read(await file.text(), { type: 'string' });
      } else {
        workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      }
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error('The uploaded file has no worksheet.');
      return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    };

    const upload = async () => {
      if (!selectedFile) {
        setError('Choose a CSV or Excel file first.');
        return;
      }
      setError('');
      setStatus('Parsing file...');
      const rows = await readRows(selectedFile);
      if (!rows.length) throw new Error('No rows found in the file.');

      const response = await fetch('/api/catalog', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(tokenInput.value.trim() ? { 'X-Catalog-Admin-Token': tokenInput.value.trim() } : {}),
        },
        body: JSON.stringify({
          payload: { items: rows },
          meta: { sourceFileName: selectedFile.name, importedAt: new Date().toISOString() },
        }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Upload failed.');
      setStatus('Saved ' + String(body.saved || 0) + ' items to the live catalog.');
    };

    fileInput.addEventListener('change', () => {
      selectedFile = fileInput.files?.[0] || null;
      fileName.textContent = selectedFile ? 'Selected: ' + selectedFile.name : 'No file selected.';
      setError('');
      setStatus(selectedFile ? 'Ready to upload.' : '');
    });

    dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
    });

    dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      selectedFile = event.dataTransfer.files?.[0] || null;
      fileName.textContent = selectedFile ? 'Selected: ' + selectedFile.name : 'No file selected.';
      setError('');
      setStatus(selectedFile ? 'Ready to upload.' : '');
    });

    saveBtn.addEventListener('click', async () => {
      try {
        await upload();
      } catch (err) {
        setError(err?.message || 'Could not upload the file.');
        setStatus('');
      }
    });
  </script>
</body>
</html>`;

export {
  normalizeCatalogPayload,
  readCatalogSource,
  renderUploadPage,
};
