import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildWeb, MAIN_PATCH_ANCHOR, MAIN_PATCH_BLOCK} from './build-web.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, 'dist', file), 'utf8');

test('web build produces the upstream UI verbatim with the bridge installed first', () => {
  const result = buildWeb(root);
  assert.equal(result.entry, 'dist/index.html');
  const html = read('index.html');
  assert.ok(html.includes('host-bridge.js'));
  assert.ok(html.indexOf('host-bridge.js') < html.indexOf('<script src="main.js"'));
  assert.ok(html.includes('@tauri-apps/plugin-dialog')); // import map
  assert.ok(html.includes('bridge.css'));
  // main.js = upstream 原文 + 恰好一处锚点补丁（__ztState 状态出口，见 docs/tabs-design.md §1）
  const upstreamMain = fs.readFileSync(path.join(root, 'upstream/ui/main.js'), 'utf8');
  const distMain = read('main.js');
  const anchorAt = upstreamMain.indexOf(MAIN_PATCH_ANCHOR);
  assert.ok(anchorAt >= 0, 'patch anchor missing in upstream main.js');
  const lineEnd = upstreamMain.indexOf('\n', anchorAt);
  const insertAt = lineEnd + 1;
  assert.equal(distMain, upstreamMain.slice(0, insertAt) + MAIN_PATCH_BLOCK + upstreamMain.slice(insertAt));
  assert.equal(distMain.split(MAIN_PATCH_BLOCK).length - 1, 1, 'patch block must appear exactly once');
  assert.ok(distMain.includes('__ztState'));
  assert.equal(read('styles.css'), fs.readFileSync(path.join(root, 'upstream/ui/styles.css'), 'utf8'));
});

test('web build ships the SDK and the local ESM shims', () => {
  buildWeb(root);
  for (const file of ['sdk/index.js', 'sdk/runtime.js', 'sdk/host-file-tree.d.ts',
                      'sdk-shims/dpi.js', 'sdk-shims/plugin-dialog.js']) {
    assert.ok(fs.existsSync(path.join(root, 'dist', file)), file);
  }
  assert.ok(!fs.existsSync(path.join(root, 'dist/private.txt')));
});

test('no native library leaks into the web payload', () => {
  buildWeb(root);
  const leaked = fs.readdirSync(path.join(root, 'dist')).filter(name => /\.(dylib|so|dll)$/i.test(name));
  assert.deepEqual(leaked, []);
});

test('main.js patch is idempotent across rebuilds', () => {
  const first = read('main.js');
  buildWeb(root);
  assert.equal(read('main.js'), first);
});

test('index.html wires the tabs controller after main.js', () => {
  const html = read('index.html');
  const bridgeAt = html.indexOf('<script src="host-bridge.js"></script>');
  const mainAt = html.indexOf('<script src="main.js"></script>');
  const tabsAt = html.indexOf('<script src="tabs.js"></script>');
  assert.ok(bridgeAt >= 0 && mainAt > bridgeAt, 'bridge must precede main.js');
  assert.ok(tabsAt > mainAt, 'tabs.js must follow main.js');
  assert.ok(fs.existsSync(path.join(root, 'dist', 'tabs.js')), 'tabs.js shipped');
});
