// shell/tabs.js 纯逻辑测试：node:vm 加载（无 DOM 环境），经 __ztTabsTest__ 驱动。
// DOM 接线在 Task 3；跨 realm 对象一律 JSON 比对。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function setup() {
  const calls = [];
  let archive = {path: '/old.zip', password: 'pw-old', format: 'zip'};
  let stack = ['parent.zip'];
  const ui = {expanded: ['x'], sortBy: 'name', sortAsc: true, query: '', scrollTop: 0};
  const deps = {
    state: {
      getCurrentArchive: () => archive,
      setCurrentArchive: (v) => { calls.push(['setArchive', v]); archive = v; },
      getArchiveStack: () => stack,
      setArchiveStack: (v) => { calls.push(['setStack', v]); stack = v; },
    },
    getUi: () => ({expanded: [...ui.expanded], sortBy: ui.sortBy, sortAsc: ui.sortAsc, query: ui.query, scrollTop: ui.scrollTop}),
    setUi: (v) => calls.push(['setUi', v]),
    render: (info) => calls.push(['render', info]),
    refresh: (p, keepStack, pw) => calls.push(['refresh', p, keepStack, pw]),
    closeCurrent: () => calls.push(['closeCurrent']),
    switchViewOpen: () => calls.push(['switchViewOpen']),
  };
  const sandbox = {window: {}, console};
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(root, 'shell/tabs.js'), 'utf8');
  vm.runInContext(source, sandbox, {filename: 'shell/tabs.js'});
  const controller = sandbox.window.__ztTabsTest__.createController(deps);
  return {
    controller,
    calls,
    kind: (name) => calls.filter((c) => c[0] === name),
    last: (name) => calls.filter((c) => c[0] === name).at(-1),
    setArchive: (a) => { archive = a; },
    setStack: (v) => { stack = v; },
    setUiState: (patch) => Object.assign(ui, patch),
  };
}

const json = (v) => JSON.stringify(v);

test('openTab creates a tab, activates it and refreshes without stack', () => {
  const t = setup();
  const tab = t.controller.openTab('/tmp/a.zip', {});
  assert.equal(t.controller.tabs.length, 1);
  assert.equal(t.controller.activeId, tab.id);
  assert.equal(tab.path, '/tmp/a.zip');
  assert.deepEqual(t.last('refresh'), ['refresh', '/tmp/a.zip', false, null]);
});

test('openTab same path reuses the existing tab', () => {
  const t = setup();
  t.controller.openTab('/tmp/a.zip', {});
  const again = t.controller.openTab('/tmp/a.zip', {});
  assert.equal(t.controller.tabs.length, 1);
  assert.equal(t.controller.activeId, again.id);
  assert.equal(t.kind('refresh').length, 2);
});

test('openTab different path adds another tab and activates it', () => {
  const t = setup();
  const a = t.controller.openTab('/tmp/a.zip', {});
  const b = t.controller.openTab('/tmp/b.zip', {});
  assert.equal(t.controller.tabs.length, 2);
  assert.equal(t.controller.activeId, b.id);
  assert.notEqual(a.id, b.id);
});

test('keepStack refreshes without creating a tab (nested drill-in)', () => {
  const t = setup();
  t.controller.openTab('/tmp/a.zip', {});
  const before = t.controller.tabs.length;
  t.controller.openTab('/tmp/a.zip!nested.zip', {keepStack: true, initialPassword: 'pw'});
  assert.equal(t.controller.tabs.length, before);
  assert.deepEqual(t.last('refresh'), ['refresh', '/tmp/a.zip!nested.zip', true, 'pw']);
});

test('snapshotActive stores independent copies of archive/stack/ui', () => {
  const t = setup();
  const tab = t.controller.openTab('/tmp/a.zip', {});
  t.setArchive({path: '/tmp/a.zip', password: 'pw1', format: 'zip', volumes: null});
  t.setStack(['outer.zip']);
  t.setUiState({expanded: ['dir/'], sortBy: 'size', sortAsc: false, query: 'txt', scrollTop: 123});
  t.controller.snapshotActive();

  assert.equal(json(tab.archive), json({path: '/tmp/a.zip', password: 'pw1', format: 'zip', volumes: null}));
  assert.equal(json(tab.stack), json(['outer.zip']));
  assert.equal(json(tab.ui), json({expanded: ['dir/'], sortBy: 'size', sortAsc: false, query: 'txt', scrollTop: 123}));

  // 来源对象后续变化不得影响快照
  t.setUiState({expanded: ['other/'], scrollTop: 999});
  assert.equal(json(tab.ui.expanded), json(['dir/']));
  assert.equal(tab.ui.scrollTop, 123);
});

test('activateTab snapshots the leaving tab then restores the target', () => {
  const t = setup();
  const a = t.controller.openTab('/tmp/a.zip', {});
  t.setArchive({path: '/tmp/a.zip', password: 'pw-a', format: 'zip'});
  t.setUiState({expanded: ['a-dir/'], sortBy: 'mtime', sortAsc: false, scrollTop: 40});
  t.controller.snapshotActive();

  const b = t.controller.openTab('/tmp/b.zip', {});
  t.setArchive({path: '/tmp/b.zip', password: 'pw-b', format: 'zip'});
  t.controller.snapshotActive();

  t.calls.length = 0;
  t.controller.activateTab(a.id);

  assert.equal(t.controller.activeId, a.id);
  assert.deepEqual(t.calls.map((c) => c[0]), ['switchViewOpen', 'setArchive', 'setStack', 'render', 'setUi']);
  const setArchive = t.last('setArchive')[1];
  assert.equal(json(setArchive), json({path: '/tmp/a.zip', password: 'pw-a', format: 'zip'}));
  assert.equal(json(t.last('render')[1]), json(a.info));
  const setUi = t.last('setUi')[1];
  assert.equal(setUi.sortBy, 'mtime');
  assert.equal(setUi.scrollTop, 40);
  assert.equal(json(setUi.expanded), json(['a-dir/']));
  assert.equal(b.path, '/tmp/b.zip');
});

test('closeTab activates a neighbor and the last close falls back to the drop zone', () => {
  const t = setup();
  const a = t.controller.openTab('/tmp/a.zip', {});
  const b = t.controller.openTab('/tmp/b.zip', {});
  t.calls.length = 0;

  t.controller.closeTab(b.id);
  assert.equal(t.controller.tabs.length, 1);
  assert.equal(t.controller.activeId, a.id);
  assert.ok(t.calls.some((c) => c[0] === 'switchViewOpen'));
  assert.ok(!t.calls.some((c) => c[0] === 'closeCurrent'));

  t.controller.closeTab(a.id);
  assert.equal(t.controller.tabs.length, 0);
  assert.equal(t.controller.activeId, null);
  assert.ok(t.calls.some((c) => c[0] === 'closeCurrent'));
});

test('closeTab on a background tab keeps the active one untouched', () => {
  const t = setup();
  const a = t.controller.openTab('/tmp/a.zip', {});
  const b = t.controller.openTab('/tmp/b.zip', {});
  t.calls.length = 0;

  t.controller.closeTab(a.id);
  assert.equal(t.controller.tabs.length, 1);
  assert.equal(t.controller.activeId, b.id);
  assert.equal(t.kind('closeCurrent').length, 0);
  assert.equal(t.kind('switchViewOpen').length, 0);
});

test('password rides with each tab across switches', () => {
  const t = setup();
  const a = t.controller.openTab('/tmp/a.zip', {initialPassword: 'secret-a'});
  t.setArchive({path: '/tmp/a.zip', password: 'secret-a', format: 'zip'});
  t.controller.snapshotActive();
  t.controller.openTab('/tmp/b.zip', {});
  t.controller.activateTab(a.id);
  const setArchive = t.last('setArchive')[1];
  assert.equal(setArchive.password, 'secret-a');
});
