import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getStaticResponse } from '../static.ts';

test('UI serves local browser modules on the API origin and only permits its exact asset allowlist', async () => {
  const index = await getStaticResponse('/', 'GET');
  assert.equal(index?.status, 200);
  assert.match(index!.headers['content-type'], /^text\/html/);
  const html = index!.body!.toString('utf8');
  assert.match(html, /<script\b[^>]*type="importmap"/);
  assert.match(html, /"ethers"\s*:\s*"\/assets\/ethers\.js"/);
  assert.match(html, /<script\b[^>]*type="module"[^>]*src="\/app\.js"/);
  assert.match(html, /<link\b[^>]*rel="stylesheet"[^>]*href="\/styles\.css"/);

  const styles = await getStaticResponse('/styles.css', 'GET');
  assert.equal(styles?.status, 200);
  assert.equal(styles!.headers['content-type'], 'text/css; charset=utf-8');
  assert.ok(styles!.body!.byteLength > 0);

  const ethers = await getStaticResponse('/assets/ethers.js', 'GET');
  assert.equal(ethers?.status, 200);
  assert.match(ethers!.headers['content-type'], /^text\/javascript/);
  assert.match(ethers!.body!.toString('utf8'), /export\{/);

  // Never turn a guessed URL into an on-disk path, including encoded traversal,
  // dotfiles, application internals and prototype-key property lookup attacks.
  for (const path of [
    '/.env', '/data/ruba.sqlite', '/server/config.ts', '/package.json', '/node_modules/ethers/package.json',
    '/../.env', '/%2e%2e/.env', '/assets/../../.env', '/assets%2fethers.js', '/__proto__', '/constructor',
  ]) assert.equal(await getStaticResponse(path, 'GET'), undefined, path);
});

test('HTML CSP permits the exact import map, rejects arbitrary inline scripts and protects wallet UI from framing', async () => {
  const response = await getStaticResponse('/', 'GET');
  const html = response!.body!.toString('utf8');
  const importMap = html.match(/<script\b[^>]*type="importmap"[^>]*>([\s\S]*?)<\/script>/)![1];
  const expectedHash = createHash('sha256').update(importMap).digest('base64');
  const csp = response!.headers['content-security-policy'];
  assert.ok(csp.includes(`'sha256-${expectedHash}'`));
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(!csp.split(";").find((directive) => directive.trim().startsWith("script-src "))!.includes("'unsafe-inline'"));
  assert.ok(!csp.includes("'unsafe-eval'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("connect-src 'self'"));
  assert.ok(csp.includes("style-src 'self' 'unsafe-inline'"));
  assert.ok(csp.includes("img-src 'self' data: blob:"));
  assert.equal(response!.headers['cache-control'], 'no-store');
  assert.equal(response!.headers['x-content-type-options'], 'nosniff');
  assert.equal(response!.headers['cross-origin-resource-policy'], 'same-origin');
});

test('HEAD preserves asset length without returning a body and unsafe methods never return files', async () => {
  const get = await getStaticResponse('/', 'GET');
  const head = await getStaticResponse('/', 'HEAD');
  assert.equal(head?.status, 200);
  assert.equal(head?.headers['content-length'], get?.headers['content-length']);
  assert.equal(head?.body, undefined);
  const post = await getStaticResponse('/', 'POST');
  assert.equal(post?.status, 405);
  assert.equal(post?.headers.allow, 'GET, HEAD');
  assert.equal(post?.body, undefined);
  // The actual JSON API remains owned by the API handler.
  assert.equal(await getStaticResponse('/actions', 'POST'), undefined);
  assert.equal(await getStaticResponse('/config', 'GET'), undefined);
});

test('Tenderly setup is an explicit static asset with a local script and no inline execution', async () => {
  const response = await getStaticResponse('/setup', 'GET');
  assert.equal(response?.status, 200);
  const html = response!.body!.toString('utf8');
  assert.match(html, /<script\b[^>]*type="module"[^>]*src="\/setup\.js"/);
  assert.match(html, /id="setup-admin-rpc"[^>]*type="password"/);
  assert.match(html, /id="setup-wallet"/);
  assert.ok(!html.includes('OPERATOR_PRIVATE_KEY'));
  assert.ok(!html.includes('localStorage'));
  assert.ok(response!.headers['content-security-policy'].includes("script-src 'self'"));
  assert.ok(!response!.headers['content-security-policy'].includes("'unsafe-inline'"));
  assert.equal((await getStaticResponse('/setup.html', 'GET'))?.body?.toString(), html);
  const script = await getStaticResponse('/setup.js', 'GET');
  assert.equal(script?.status, 200);
  assert.match(script!.headers['content-type'], /^text\/javascript/);
  assert.equal((await getStaticResponse('/setup', 'POST'))?.status, 405);
  assert.equal(await getStaticResponse('/setup/status', 'GET'), undefined);
});

test('disclosure page is a public standalone static page with only local modules', async () => {
  const response = await getStaticResponse('/disclosure', 'GET');
  assert.equal(response?.status, 200);
  const html = response!.body!.toString('utf8');
  assert.match(html, /\/disclosure\.js/);
  assert.ok(!html.includes('data-requires-entry'));
  assert.ok(!html.includes('OPERATOR_PRIVATE_KEY'));
  assert.ok(response!.headers['content-security-policy'].includes("script-src 'self'"));
  assert.equal((await getStaticResponse('/disclosure.html', 'GET'))?.body?.toString(), html);
  for (const path of ['/disclosure.js', '/disclosure-model.js']) {
    assert.equal((await getStaticResponse(path, 'GET'))?.status, 200);
  }
});


test('wallet selector is served locally while standalone pages keep strict styles', async () => {
  for (const path of ['/wallet-connector.js', '/assets/wallet-onboard.js']) {
    const asset = await getStaticResponse(path, 'GET');
    assert.equal(asset?.status, 200);
    assert.match(asset!.headers['content-type'], /^text\/javascript/);
    assert.ok(asset!.body!.length > 0);
  }
  for (const path of ['/disclosure', '/setup']) {
    const csp = (await getStaticResponse(path, 'GET'))!.headers['content-security-policy'];
    assert.ok(csp.includes("style-src 'self'"));
    assert.ok(!csp.includes("'unsafe-inline'"));
  }
  assert.equal(await getStaticResponse('/assets/wallet-onboard-entry.js', 'GET'), undefined);
});
