import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildWeb} from './build-web.mjs';

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
  assert.equal(read('main.js'), fs.readFileSync(path.join(root, 'upstream/ui/main.js'), 'utf8'));
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
