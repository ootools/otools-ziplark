// shell/host-bridge.js 的纯逻辑测试：node:vm 加载 classic script（不进宿主），
// 通过 window.__ZIPLARK_TEST__ 钩子驱动。宿主集成行为由 Task 3 的端到端验证覆盖。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeWindow() {
  const window = {
    console,
    __TAURI_INTERNALS__: {metadata: {currentWebview: {label: 'tools-tab-plugin-market:otools-ziplark'}}},
  };
  const sandbox = {window, console};
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(root, 'shell/host-bridge.js'), 'utf8');
  vm.runInContext(source, sandbox, {filename: 'shell/host-bridge.js'});
  return window;
}

test('resolvePluginUuid falls back to the webview label suffix', () => {
  const window = makeWindow();
  assert.equal(window.__ZIPLARK_TEST__.resolvePluginUuid(), 'otools-ziplark');
});

test('resolvePluginUuid prefers __OToolsEnv.pluginUuid and trims it', () => {
  const window = makeWindow();
  window.__OToolsEnv = {pluginUuid: '  otools-ziplark  '};
  assert.equal(window.__ZIPLARK_TEST__.resolvePluginUuid(), 'otools-ziplark');
});

test('resolvePluginUuid keeps non-market labels verbatim and handles blanks', () => {
  const window = makeWindow();
  const hooks = window.__ZIPLARK_TEST__;
  assert.equal(hooks.normalizePluginUuidFromLabel('some-other-label'), 'some-other-label');
  assert.equal(hooks.normalizePluginUuidFromLabel(''), '');
  window.__TAURI_INTERNALS__.metadata.currentWebview.label = '';
  assert.equal(hooks.resolvePluginUuid(), '');
});

test('deliverOpenPath emits once per dedupe window and re-emits after expiry', async () => {
  const window = makeWindow();
  const events = [];
  await window.__TAURI__.event.listen('ziplark-open-file', (e) => events.push(e.payload));
  const hooks = window.__ZIPLARK_TEST__;

  hooks.deliverOpenPath('/tmp/a.zip');
  assert.deepEqual(events, ['/tmp/a.zip']);

  hooks.deliverOpenPath('/tmp/a.zip');
  assert.deepEqual(events, ['/tmp/a.zip'], 'within the 5s window must dedupe');

  hooks.recentDeliveries.delete('/tmp/a.zip'); // simulate window expiry
  hooks.deliverOpenPath('/tmp/a.zip');
  assert.deepEqual(events, ['/tmp/a.zip', '/tmp/a.zip']);
});

test('deliverOpenPath ignores blank paths and prunes expired entries', () => {
  const window = makeWindow();
  const hooks = window.__ZIPLARK_TEST__;
  hooks.deliverOpenPath('');
  hooks.deliverOpenPath('   ');
  assert.equal(hooks.recentDeliveries.size, 0);

  hooks.recentDeliveries.set('/tmp/old.zip', Date.now() - 10_000);
  hooks.deliverOpenPath('/tmp/new.zip');
  assert.ok(!hooks.recentDeliveries.has('/tmp/old.zip'), 'expired entries are pruned');
  assert.ok(hooks.recentDeliveries.has('/tmp/new.zip'));
});
