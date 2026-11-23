import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface StaticResponse {
  status: number;
  headers: Record<string, string>;
  body?: Buffer;
}

// Deliberately an allowlist, not a directory server: the operator key, SQLite
// journal, contract sources and arbitrary node_modules files must stay private.
const assets: Record<string, { file: URL; contentType: string }> = {
  '/': { file: new URL('../ui/index.html', import.meta.url), contentType: 'text/html; charset=utf-8' },
  '/index.html': { file: new URL('../ui/index.html', import.meta.url), contentType: 'text/html; charset=utf-8' },
  '/disclosure': { file: new URL('../ui/disclosure.html', import.meta.url), contentType: 'text/html; charset=utf-8' },
  '/disclosure.html': { file: new URL('../ui/disclosure.html', import.meta.url), contentType: 'text/html; charset=utf-8' },
  '/disclosure.js': { file: new URL('../ui/disclosure.js', import.meta.url), contentType: 'text/javascript; charset=utf-8' },
  '/disclosure-model.js': { file: new URL('../ui/disclosure-model.js', import.meta.url), contentType: 'text/javascript; charset=utf-8' },
  '/setup': { file: new URL('../ui/setup.html', import.meta.url), contentType: 'text/html; charset=utf-8' },
  '/setup.html': { file: new URL('../ui/setup.html', import.meta.url), contentType: 'text/html; charset=utf-8' },
  '/setup.js': { file: new URL('../ui/setup.js', import.meta.url), contentType: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: new URL('../ui/styles.css', import.meta.url), contentType: 'text/css; charset=utf-8' },
  '/app.js': { file: new URL('../ui/app.js', import.meta.url), contentType: 'text/javascript; charset=utf-8' },
  '/client.js': { file: new URL('../ui/client.js', import.meta.url), contentType: 'text/javascript; charset=utf-8' },
  '/model.js': { file: new URL('../ui/model.js', import.meta.url), contentType: 'text/javascript; charset=utf-8' },
  '/markets.js': { file: new URL('../ui/markets.js', import.meta.url), contentType: 'text/javascript; charset=utf-8' },
  '/wallet-connector.js': { file: new URL('../ui/wallet-connector.js', import.meta.url), contentType: 'text/javascript; charset=utf-8' },
  '/assets/wallet-onboard.js': { file: new URL('../ui/vendor/wallet-onboard.js', import.meta.url), contentType: 'text/javascript; charset=utf-8' },
  '/assets/zk-crypto.js': { file: new URL('../zk/crypto.js', import.meta.url), contentType: 'text/javascript; charset=utf-8' },
  '/assets/crypto.js': { file: new URL('../zk/crypto.js', import.meta.url), contentType: 'text/javascript; charset=utf-8' },
  '/assets/zk-recovery.js': { file: new URL('../zk/recovery.js', import.meta.url), contentType: 'text/javascript; charset=utf-8' },
  '/assets/ethers.js': {
    file: new URL('../node_modules/ethers/dist/ethers.min.js', import.meta.url),
    contentType: 'text/javascript; charset=utf-8',
  },
};

function contentSecurityPolicy(html: string, walletPage: boolean): string {
  // Native import maps are inline script elements. Authorize their exact bytes
  // without permitting arbitrary inline JavaScript or event handler attributes.
  const hashes = [...html.matchAll(/<script\b[^>]*\btype=(?:"importmap"|'importmap')[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
  return [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "connect-src 'self'",
    // Web3 Onboard renders its Svelte component styles and wallet SVG icons.
    // Only the exchange uses that UI; standalone disclosure/setup stay strict.
    walletPage ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    walletPage ? "img-src 'self' data: blob:" : "img-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** Static UI on the API's origin. Unknown paths are left to the JSON API. */
export async function getStaticResponse(pathname: string, method: string): Promise<StaticResponse | undefined> {
  if (!Object.hasOwn(assets, pathname)) return undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    return {
      status: 405,
      headers: { allow: 'GET, HEAD', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    };
  }
  const asset = assets[pathname];
  const body = await readFile(asset.file);
  const headers: Record<string, string> = {
    'content-type': asset.contentType,
    'content-length': body.byteLength.toString(),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
  };
  if (asset.contentType.startsWith('text/html')) {
    headers['content-security-policy'] = contentSecurityPolicy(body.toString('utf8'), pathname === '/' || pathname === '/index.html');
  }
  return { status: 200, headers, ...(method === 'HEAD' ? {} : { body }) };
}
