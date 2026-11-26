// shell/tabs.js 纯逻辑测试：node:vm 加载（无 DOM 环境），经 __ztTabsTest__ 驱动。
// 契约（0.2.1 热修，见发后审计 P1×3）：openTab 返回 {tab, done}，done=true ⟺ 刷新
// 真正产出了渲染（renderToken 前进）；失败时新建 tab 回收、既有 tab 恢复自身栈、
// 页面与 activeId 永不自相矛盾。运行时的 renderArchive 包装（setActiveInfo）在测试里
// 以 refresh 内部的 setActiveInfo 模拟上游 openArchive 里的 renderArchive 调用，
// 确保测试与真实时序（refresh 过程中 activeId 已指向目标 tab）一致。跨 realm 对象一律 JSON 比对。
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
  const ui = {expanded: ['x'], selected: ['x/file.txt'], sortBy: 'name', sortAsc: true, query: '', scrollTop: 0};
  let token = 0;
  let controller;
  const deps = {
    state: {
      getCurrentArchive: () => archive,
      setCurrentArchive: (v) => { calls.push(['setArchive', v]); archive = v; },
      getArchiveStack: () => stack,
      setArchiveStack: (v) => { calls.push(['setStack', v]); stack = v; },
    },
    getUi: () => ({expanded: [...ui.expanded], selected: [...ui.selected], sortBy: ui.sortBy, sortAsc: ui.sortAsc, query: ui.query, scrollTop: ui.scrollTop}),
    setUi: (v) => calls.push(['setUi', v]),
    render: (info) => calls.push(['render', info]),
    renderToken: () => token,
    refresh: (p, keepStack, pw) => {
      calls.push(['refresh', p, keepStack, pw]);
      // 模拟上游 openArchive：成功时产出渲染并设置 currentArchive；失败时两者皆无
      return Promise.resolve().then(() => {
        token += 1;
        archive = {path: p, password: pw ?? null, format: 'zip'};
        // 模拟上游 openArchive 内部的 renderArchive(info) → tabs.js 包装：
        // 这一步发生在 refresh 期间，activeId 必须已经指向本次打开的 tab。
        if (controller) controller.setActiveInfo({path: p, entries: []});
      });
    },
    closeCurrent: () => calls.push(['closeCurrent']),
    switchViewOpen: () => calls.push(['switchViewOpen']),
  };
  const sandbox = {window: {}, console};
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(root, 'shell/tabs.js'), 'utf8');
  vm.runInContext(source, sandbox, {filename: 'shell/tabs.js'});
  controller = sandbox.window.__ztTabsTest__.createController(deps);
  const t = {
    controller,
    calls,
    kind: (name) => calls.filter((c) => c[0] === name),
    last: (name) => calls.filter((c) => c[0] === name).at(-1),
    openAndWait: async (p, opts) => {
      const {tab, done} = t.controller.openTab(p, opts || {});
      const ok = await done;
      return {tab, ok};
    },
    failNextRefresh: () => {
      deps.refresh = (p, keepStack, pw) => { calls.push(['refresh', p, keepStack, pw]); return Promise.resolve(); };
    },
    setArchive: (a) => { archive = a; },
    setStack: (v) => { stack = v; },
    setUiState: (patch) => Object.assign(ui, patch),
  };
  return t;
}

const json = (v) => JSON.stringify(v);

test('openTab 新路径：刷新产出渲染后置为激活并快照', async () => {
  const t = setup();
  const {tab, ok} = await t.openAndWait('/tmp/a.zip', {});
  assert.equal(ok, true);
  assert.equal(t.controller.tabs.length, 1);
  assert.equal(t.controller.activeId, tab.id);
  assert.deepEqual(t.last('refresh'), ['refresh', '/tmp/a.zip', false, null]);
  assert.equal(json(tab.archive.path), json('/tmp/a.zip'));
  assert.ok(tab.info, '渲染包装已把 info 记入 tab');
});

test('openTab 新路径失败：tab 回收、activeId 与状态不被污染', async () => {
  const t = setup();
  t.failNextRefresh();
  const {tab, done} = await Promise.resolve(t.controller.openTab('/tmp/bad.zip', {}));
  assert.equal(await done, false);
  assert.equal(t.controller.tabs.length, 0);
  assert.equal(t.controller.activeId, null);
  assert.equal(t.kind('setArchive').length, 0);
  assert.equal(t.kind('setStack').length, 0);
  // tab 引用仍在返回值上，但已从注册表移除
  assert.equal(t.controller.tabs.includes(tab), false);
});

test('openTab 同路径：先恢复已保存视图再刷新，成功后快照刷新结果', async () => {
  const t = setup();
  const {tab: a, ok: aOk} = await t.openAndWait('/tmp/a.zip', {});
  assert.equal(aOk, true);
  t.setArchive({path: '/tmp/a.zip', password: 'pw-a', format: 'zip'});
  t.controller.snapshotActive();
  t.calls.length = 0;

  const {tab, done} = await Promise.resolve(t.controller.openTab('/tmp/a.zip', {}));
  assert.equal(await done, true);
  assert.equal(tab.id, a.id);
  const order = t.calls.map((c) => c[0]);
  assert.ok(order.indexOf('refresh') > order.indexOf('render'), '先恢复视图（render）再刷新');
  assert.equal(t.controller.activeId, a.id);
});

test('openTab 同路径失败：tab 保留旧数据、栈被恢复、页面状态一致', async () => {
  const t = setup();
  const {tab: a, ok: aOk} = await t.openAndWait('/tmp/a.zip', {});
  assert.equal(aOk, true);
  assert.ok(a.info);
  t.setArchive({path: '/tmp/a.zip', password: 'pw-a', format: 'zip'});
  t.setStack(['outer.zip']);
  t.controller.snapshotActive();
  t.calls.length = 0;

  t.failNextRefresh(); // 上游 openArchive 失败时 resolve 且不产出渲染
  const {done} = await Promise.resolve(t.controller.openTab('/tmp/a.zip', {}));
  assert.equal(await done, false);
  assert.equal(t.controller.tabs.length, 1);
  assert.equal(t.controller.activeId, a.id);
  // 上游在刷新前清空了 archiveStack：控制器必须恢复 tab 的已存栈
  assert.deepEqual(t.last('setStack'), ['setStack', ['outer.zip']]);
  assert.equal(json(a.archive), json({path: '/tmp/a.zip', password: 'pw-a', format: 'zip'}));
  assert.ok(a.info, '既有 info 保留');
});

test('openTab 另一路径失败：页面与激活 tab 都不变化', async () => {
  const t = setup();
  const {tab: a, ok: aOk} = await t.openAndWait('/tmp/a.zip', {});
  assert.equal(aOk, true);
  t.calls.length = 0;

  t.failNextRefresh();
  const {done} = await Promise.resolve(t.controller.openTab('/tmp/b.zip', {}));
  assert.equal(await done, false);
  assert.equal(t.controller.tabs.length, 1);
  assert.equal(t.controller.activeId, a.id);
  assert.equal(t.kind('setArchive').length, 0);
  assert.equal(t.kind('render').length, 0, '失败不得触碰页面渲染');
});

test('keepStack：成功时快照进当前 tab，失败时恢复栈且不建 tab', async () => {
  const t = setup();
  const {tab: a, ok: aOk} = await t.openAndWait('/tmp/a.zip', {});
  assert.equal(aOk, true);
  t.calls.length = 0;

  t.setStack(['outer.zip']);
  const r1 = t.controller.openTab('/tmp/a.zip!nested.zip', {keepStack: true});
  assert.equal(await r1.done, true);
  t.controller.setActiveInfo({path: '/tmp/a.zip!nested.zip', entries: []});
  assert.equal(t.controller.tabs.length, 1);
  assert.ok(t.controller.tabs[0].info, '嵌套 info 记入当前 tab');

  t.setStack(['outer.zip']);
  t.failNextRefresh();
  const r2 = t.controller.openTab('/tmp/a.zip!nested2.zip', {keepStack: true});
  assert.equal(await r2.done, false);
  assert.equal(t.controller.tabs.length, 1);
  // 控制器把 tab 已存栈恢复为权威状态
  assert.deepEqual(t.last('setStack'), ['setStack', ['outer.zip']]);
  assert.equal(t.kind('setArchive').length, 0, '失败不得改写 currentArchive');
});

test('密码随 tab 保存并在切换时恢复', async () => {
  const t = setup();
  const {tab: a, ok: aOk} = await t.openAndWait('/tmp/a.zip', {initialPassword: 'secret-a'});
  assert.equal(aOk, true);
  assert.equal(a.archive.password, 'secret-a');
  const b = t.controller.openTab('/tmp/b.zip', {});
  await b.done;

  t.controller.activateTab(a.id);
  assert.equal(t.last('setArchive')[1].password, 'secret-a');
});

test('切换 tab：快照离开页、恢复目标页', async () => {
  const t = setup();
  const {tab: a, ok: aOk} = await t.openAndWait('/tmp/a.zip', {});
  assert.equal(aOk, true);
  t.setUiState({expanded: ['a-dir/'], sortBy: 'mtime', sortAsc: false, scrollTop: 40});
  t.controller.snapshotActive();
  const b = t.controller.openTab('/tmp/b.zip', {});
  await b.done;
  t.calls.length = 0;

  t.controller.activateTab(a.id);
  assert.equal(t.controller.activeId, a.id);
  assert.deepEqual(t.calls.map((c) => c[0]), ['switchViewOpen', 'setArchive', 'setStack', 'render', 'setUi']);
  assert.equal(t.last('setUi')[1].sortBy, 'mtime');
  assert.equal(t.last('setUi')[1].scrollTop, 40);
});

test('closeTab：激活相邻页，最后一个回落拖放区', async () => {
  const t = setup();
  const {tab: a, ok: aOk} = await t.openAndWait('/tmp/a.zip', {});
  assert.equal(aOk, true);
  const {tab: b, ok: bOk} = await t.openAndWait('/tmp/b.zip', {});
  assert.equal(bOk, true);
  t.calls.length = 0;

  t.controller.closeTab(b.id);
  assert.equal(t.controller.tabs.length, 1);
  assert.equal(t.controller.activeId, a.id);
  assert.ok(t.calls.some((c) => c[0] === 'switchViewOpen'));
  assert.equal(t.kind('closeCurrent').length, 0);

  t.controller.closeTab(a.id);
  assert.equal(t.controller.tabs.length, 0);
  assert.ok(t.calls.some((c) => c[0] === 'closeCurrent'));
});

test('打开多个归档：info 在 refresh 期间写入各自 tab（P0 时序回归）', async () => {
  const t = setup();
  const {tab: a, ok: aOk} = await t.openAndWait('/tmp/a.zip', {});
  assert.equal(aOk, true);
  const {tab: b, ok: bOk} = await t.openAndWait('/tmp/b.zip', {});
  assert.equal(bOk, true);
  assert.equal(json(a.info), json({path: '/tmp/a.zip', entries: []}));
  assert.equal(json(b.info), json({path: '/tmp/b.zip', entries: []}));

  t.calls.length = 0;
  t.controller.activateTab(b.id);
  assert.equal(json(t.last('render')[1]), json({path: '/tmp/b.zip', entries: []}));
  t.controller.activateTab(a.id);
  assert.equal(json(t.last('render')[1]), json({path: '/tmp/a.zip', entries: []}));
});

test('新 tab 打开失败：回滚到离开页并恢复其栈', async () => {
  const t = setup();
  const {tab: a, ok: aOk} = await t.openAndWait('/tmp/a.zip', {});
  assert.equal(aOk, true);
  t.setStack(['outer.zip']);
  t.controller.snapshotActive();
  t.calls.length = 0;

  t.failNextRefresh();
  const {done} = await Promise.resolve(t.controller.openTab('/tmp/bad.zip', {}));
  assert.equal(await done, false);
  assert.equal(t.controller.activeId, a.id);
  assert.deepEqual(t.last('setStack'), ['setStack', ['outer.zip']], '离开页的栈被恢复');
  assert.equal(json(a.info), json({path: '/tmp/a.zip', entries: []}), '离开页 info 未被污染');
});

test('选中状态随 tab 保存与恢复（Review Focus #1）', async () => {
  const t = setup();
  const {tab: a, ok: aOk} = await t.openAndWait('/tmp/a.zip', {});
  assert.equal(aOk, true);
  t.setUiState({selected: ['a/1.txt']});
  t.controller.snapshotActive();
  const {tab: b, ok: bOk} = await t.openAndWait('/tmp/b.zip', {});
  assert.equal(bOk, true);
  t.setUiState({selected: ['b/2.txt']});
  t.controller.snapshotActive();

  t.controller.activateTab(a.id);
  assert.deepEqual(t.last('setUi')[1].selected, ['a/1.txt']);
  t.controller.activateTab(b.id);
  assert.deepEqual(t.last('setUi')[1].selected, ['b/2.txt']);
});

test('DOM 接线：btn-close.onclick 指向包装后的 closeArchive', () => {
  const element = () => ({
    className: '', textContent: '', title: '',
    appendChild() {}, addEventListener() {}, classList: {toggle() {}},
  });
  const originalClose = function () { return 'original'; };
  const closeBtn = {onclick: originalClose, addEventListener() {}};
  const sandboxWindow = {
    __ztState: {
      getCurrentArchive: () => null,
      setCurrentArchive() {},
      getArchiveStack: () => [],
      setArchiveStack() {},
      getTree: () => ({expanded: new Set(), selected: new Set(), sortBy: 'name', sortAsc: true, query: ''}),
    },
    openArchive() {}, closeArchive: originalClose, renderArchive() {},
    switchView() {}, flatten() {}, renderRows() {}, updateSelectionUi() {},
  };
  const sandbox = {
    window: sandboxWindow,
    document: {
      querySelector: () => null,
      createElement: () => element(),
      getElementById: (id) => (id === 'btn-close' ? closeBtn : element()),
      addEventListener() {},
    },
    localStorage: {getItem: () => 'en'},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'shell/tabs.js'), 'utf8'), sandbox, {filename: 'shell/tabs.js'});
  assert.notEqual(closeBtn.onclick, originalClose, 'Close 按钮必须重绑到控制器包装');
  assert.equal(closeBtn.onclick, sandboxWindow.closeArchive);
});
