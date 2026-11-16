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

test('consumeOpenFiles delivers every consumed path locally with the plugin uuid', async () => {
  const window = makeWindow();
  const events = [];
  const invokes = [];
  window.otools = {
    invoke: async (command, args) => {
      invokes.push([command, args]);
      return ['/a.zip', '/b.zip'];
    },
    invokeNative: () => assert.fail('consume must not reach the dylib'),
  };
  await window.__TAURI__.event.listen('ziplark-open-file', (e) => events.push(e.payload));

  await window.__ZIPLARK_TEST__.consumeOpenFiles();

  // vm 跨 realm 对象原型不同，逐字段断言而不是 deepEqual。
  assert.equal(invokes.length, 1);
  assert.equal(invokes[0][0], 'otools_consume_open_files');
  assert.equal(invokes[0][1].pluginUuid, 'otools-ziplark');
  assert.deepEqual(events, ['/a.zip', '/b.zip']);
});

test('consumeOpenFiles tolerates an empty queue and an invoke failure', async () => {
  const window = makeWindow();
  const events = [];
  await window.__TAURI__.event.listen('ziplark-open-file', (e) => events.push(e.payload));

  window.otools = {invoke: async () => []};
  await window.__ZIPLARK_TEST__.consumeOpenFiles();
  assert.deepEqual(events, []);

  window.otools = {invoke: async () => { throw new Error('Unknown method'); }};
  await window.__ZIPLARK_TEST__.consumeOpenFiles(); // must not throw
  assert.deepEqual(events, []);
});

test('the SDK open-file callback delivers locally and never calls push_open_file', async () => {
  const window = makeWindow();
  const events = [];
  let nativeCalls = 0;
  window.otools = {
    invoke: async () => [],
    invokeNative: () => { nativeCalls += 1; },
  };
  await window.__TAURI__.event.listen('ziplark-open-file', (e) => events.push(e.payload));

  window.__ZIPLARK_TEST__.handleOtoolsOpenFile([{path: '/a.zip'}]);
  window.__ZIPLARK_TEST__.handleOtoolsOpenFile([{path: ''}, null]);
  assert.deepEqual(events, ['/a.zip']);
  assert.equal(nativeCalls, 0, 'push_open_file must stay retired');
});

test('knockListenerTargets prefers the webview label and falls back to Any', () => {
  const window = makeWindow();
  const hooks = window.__ZIPLARK_TEST__;
  const targets = hooks.knockListenerTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].kind, 'Webview');
  assert.equal(targets[0].label, 'tools-tab-plugin-market:otools-ziplark');

  window.__TAURI_INTERNALS__.metadata.currentWebview.label = '';
  const fallback = hooks.knockListenerTargets();
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].kind, 'Any');
});
