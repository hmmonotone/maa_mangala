import { renderUploadPage } from './_shared/catalog.js';

export async function onRequest() {
  return new Response(renderUploadPage(), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
