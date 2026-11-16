/*!
 * Ziplark 归档多标签（TABS）：控制器核心 + DOM 接线。
 *
 * 设计：docs/tabs-design.md（v2，PATCH 方案）+ 发后审计 0.2.1 热修契约。
 * main.js 的三个状态变量是脚本作用域 let/const，构建补丁（scripts/build-web.mjs
 * 的 MAIN_PATCH_*）注入 `window.__ztState` 读写出口；本文件运行时包装全局函数
 * openArchive/closeArchive/renderArchive，注入标签条 DOM。上游 `upstream/ui/` 快照不改。
 *
 * 0.2.1 关键语义（发后审计 P1×3 的根因修复）：
 *  - 上游 openArchive 失败时同样 resolve（toast + return），永不 reject——成功与否
 *    只能靠「本次刷新是否产出了渲染」（renderToken 前进）判定；
 *  - openTab 返回 {tab, done}，done=false 时：新建 tab 回收、既有 tab 恢复自身栈，
 *    activeId 与页面永不自相矛盾；
 *  - 事件驱动的打开（敲门/拖拽）不经 busy 遮罩：所有打开经 openQueue 串行化，
 *    防止并发 list_archive 的渲染交叉污染；
 *  - 包装返回刷新 promise，保留上游 `await openArchive(...)` 的时序契约。
 */
(function () {
  'use strict';

  /* ---------- 控制器核心（依赖注入，可单测） ---------- */

  function copyArchive(value) {
    return value ? Object.assign({}, value) : null;
  }

  /**
   * @param deps {state, getUi, setUi, render(info), renderToken(), refresh(path, keepStack, pw),
   *              closeCurrent(), switchViewOpen()}
   *   - state：构建补丁注入的 `__ztState`（get/set currentArchive/stack、get tree）。
   *   - renderToken：renderArchive 包装的递增序号——刷新后未前进即视为失败。
   */
  function createController(deps) {
    const tabs = [];
    let activeId = null;
    let seq = 0;

    const byId = (id) => tabs.find((tab) => tab.id === id);
    const byPath = (path) => tabs.find((tab) => tab.path === String(path || '').trim());

    /** 把当前页面状态（archive/stack/ui）存进激活的 tab。 */
    function snapshotActive() {
      const tab = byId(activeId);
      if (!tab) return;
      tab.archive = copyArchive(deps.state.getCurrentArchive());
      tab.stack = (deps.state.getArchiveStack() || []).slice();
      tab.ui = deps.getUi();
    }

    /** 激活目标 tab：先快照离开页，再写状态、重渲染、恢复 ui。 */
    function activateTab(id) {
      const tab = byId(id);
      if (!tab) return;
      snapshotActive();
      activeId = id;
      deps.switchViewOpen();
      deps.state.setCurrentArchive(copyArchive(tab.archive));
      deps.state.setArchiveStack((tab.stack || []).slice());
      deps.render(tab.info);
      deps.setUi(tab.ui);
    }

    function removeTab(id) {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index >= 0) tabs.splice(index, 1);
      if (activeId === id) activeId = null;
    }

    /**
     * 打开入口（包装 openArchive 的落点）。返回 {tab, done}：
     *  - done=true ⟺ 刷新产出了渲染（成功）；
     *  - 新路径：成功才置为激活并快照；失败回收 tab（页面未被触碰）；
     *  - 既有路径：先恢复已保存视图（页面自洽）再刷新，失败恢复自身栈；
     *  - keepStack（嵌套钻取）：归属当前 tab，失败恢复栈、不改写 currentArchive。
     */
    function openTab(path, options) {
      const opts = options || {};
      const normalized = String(path || '').trim();
      if (!normalized) return {tab: null, done: Promise.resolve(false)};
      const tokenBefore = deps.renderToken();
      let tab = null;
      let created = false;

      if (opts.keepStack) {
        tab = byId(activeId);
      } else {
        tab = byPath(normalized);
        if (!tab) {
          tab = {id: ++seq, path: normalized, archive: null, stack: [], info: null, ui: null};
          tabs.push(tab);
          created = true;
        }
      }

      const done = Promise.resolve().then(async () => {
        if (!opts.keepStack && !created) {
          // 重开既有 tab：先把已保存视图还原到页面（刷新在途时页面仍自洽），再刷新
          activateTab(tab.id);
        }
        await deps.refresh(normalized, opts.keepStack === true, opts.initialPassword ?? null);
        if (deps.renderToken() <= tokenBefore) {
          // 上游 openArchive 失败时同样 resolve（toast + return）：无渲染即失败
          throw new Error('refresh-produced-no-render');
        }
        if (!opts.keepStack && created) {
          activeId = tab.id;
        }
        snapshotActive();
        return true;
      }).catch(() => {
        if (created) {
          removeTab(tab.id);
        } else if (tab) {
          // 上游刷新前清空 archiveStack：把 tab 已存栈恢复为权威状态
          deps.state.setArchiveStack((tab.stack || []).slice());
        }
        return false;
      });

      return {tab, done};
    }

    /** 关闭 tab：激活页关闭时激活相邻页（相邻页不存在则回到拖放区）。 */
    function closeTab(id) {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;
      const wasActive = activeId === id;
      tabs.splice(index, 1);
      if (!wasActive) return;
      activeId = null;
      const neighbor = tabs[index] || tabs[index - 1];
      if (neighbor) {
        activateTab(neighbor.id);
      } else {
        deps.closeCurrent();
      }
    }

    /** renderArchive 包装调用：把 list_archive 结果记到激活的 tab。 */
    function setActiveInfo(info) {
      const tab = byId(activeId);
      if (tab) tab.info = info;
    }

    return {tabs, get activeId() { return activeId; }, openTab, snapshotActive, activateTab, closeTab, setActiveInfo};
  }

  /* ---------- 测试钩子 ---------- */

  window.__ztTabsTest__ = {createController};

  /* ---------- DOM 接线（无 document 的测试环境跳过） ---------- */

  if (typeof document === 'undefined' || !document.querySelector) {
    return;
  }

  const $ = (id) => document.getElementById(id);
  const basename = (p) => String(p || '').split(/[\\/]/).pop() || p;

  const originalOpenArchive = typeof window.openArchive === 'function' ? window.openArchive : null;
  const originalCloseArchive = typeof window.closeArchive === 'function' ? window.closeArchive : null;
  const originalRenderArchive = typeof window.renderArchive === 'function' ? window.renderArchive : null;
  if (!originalOpenArchive || !originalCloseArchive || !originalRenderArchive || !window.__ztState) {
    // upstream 装配顺序异常 / 补丁缺失：放弃包装，保持原单归档行为。
    return;
  }

  /* 标签条文案跟随上游 9 语言设置（applyLanguage 写 localStorage）。 */
  const TABS_I18N = {
    en: {open: '+ Open archive', close: 'Close'},
    'zh-CN': {open: '＋ 打开归档', close: '关闭'},
    'zh-TW': {open: '＋ 開啟封存檔', close: '關閉'},
    ja: {open: '＋ 開く', close: '閉じる'},
    ko: {open: '＋ 열기', close: '닫기'},
    es: {open: '+ Abrir archivo', close: 'Cerrar'},
    fr: {open: '+ Ouvrir une archive', close: 'Fermer'},
    de: {open: '+ Archiv öffnen', close: 'Schließen'},
    ru: {open: '+ Открыть архив', close: 'Закрыть'},
  };
  function tabText() {
    let lang = null;
    try { lang = localStorage.getItem('ziplark-lang'); } catch (_) { /* 隐私模式等 */ }
    return TABS_I18N[lang] || TABS_I18N.en;
  }

  let renderSeq = 0;
  let lastRefreshPromise = null;
  let openQueue = Promise.resolve();

  const controller = createController({
    state: window.__ztState,
    getUi: () => {
      const tree = window.__ztState.getTree();
      return {
        expanded: [...tree.expanded],
        sortBy: tree.sortBy,
        sortAsc: tree.sortAsc,
        query: tree.query,
        scrollTop: $('tree') ? $('tree').scrollTop : 0,
      };
    },
    setUi: (ui) => {
      const tree = window.__ztState.getTree();
      tree.expanded = new Set(ui.expanded || []);
      tree.sortBy = ui.sortBy || 'name';
      tree.sortAsc = ui.sortAsc !== false;
      tree.query = ui.query || '';
      if ($('tree-search')) $('tree-search').value = tree.query;
      window.flatten();
      window.renderRows();
      window.updateSelectionUi();
      if ($('tree')) $('tree').scrollTop = ui.scrollTop || 0;
      renderStrip();
    },
    render: (info) => {
      const result = originalRenderArchive(info);
      renderStrip();
      return result;
    },
    renderToken: () => renderSeq,
    refresh: (path, keepStack, initialPassword) => {
      lastRefreshPromise = originalOpenArchive(path, keepStack, initialPassword);
      return lastRefreshPromise;
    },
    closeCurrent: () => originalCloseArchive(),
    switchViewOpen: () => window.switchView('open'),
  });

  /* 包装上游全局函数：函数声明挂 window，main.js 内部调用同样命中包装版。 */
  window.renderArchive = function (info) {
    renderSeq += 1;
    controller.setActiveInfo(info);
    return originalRenderArchive(info);
  };

  // 所有打开（按钮/拖拽/敲门/URL 兜底）经 openQueue 串行化：事件驱动的打开不经
  // busy 遮罩，并发 list_archive 会交叉渲染并污染相邻 tab 的快照。
  window.openArchive = function (path, keepStack, initialPassword) {
    const run = openQueue.then(() => {
      const {done} = controller.openTab(path, {keepStack: keepStack === true, initialPassword: initialPassword ?? null});
      return done;
    });
    openQueue = run.then(() => renderStrip()).catch(() => {
      renderStrip();
    });
    return run;
  };

  window.closeArchive = function () {
    if (controller.tabs.length && controller.activeId != null) {
      controller.closeTab(controller.activeId);
      renderStrip();
      return;
    }
    return originalCloseArchive();
  };

  /* ---------- 标签条 ---------- */

  const strip = document.createElement('div');
  strip.className = 'zt-tabstrip hidden';
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'zt-tab zt-open-btn';
  const stripItems = document.createElement('div');
  stripItems.className = 'zt-tab-items';
  strip.appendChild(openBtn);
  strip.appendChild(stripItems);
  const topbar = document.querySelector('.topbar');
  if (topbar && topbar.parentNode) {
    topbar.parentNode.insertBefore(strip, topbar.nextSibling);
  }
  openBtn.addEventListener('click', () => {
    const btn = $('btn-open');
    if (btn) btn.click();
  });
  document.addEventListener('change', (event) => {
    if (event.target && event.target.id === 'lang-select') {
      applyStripText();
      renderStrip();
    }
  });

  function applyStripText() {
    const text = tabText();
    openBtn.textContent = text.open;
    openBtn.title = text.open;
  }

  function renderStrip() {
    applyStripText();
    stripItems.textContent = '';
    for (const tab of controller.tabs) {
      const el = document.createElement('div');
      el.className = 'zt-tab' + (tab.id === controller.activeId ? ' active' : '');
      el.title = tab.path;
      const name = document.createElement('span');
      name.className = 'zt-tab-name';
      name.textContent = basename(tab.path);
      el.appendChild(name);
      const close = document.createElement('span');
      close.className = 'zt-close';
      close.textContent = '×';
      close.title = tabText().close;
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        controller.closeTab(tab.id);
        renderStrip();
      });
      el.appendChild(close);
      el.addEventListener('click', () => controller.activateTab(tab.id));
      stripItems.appendChild(el);
    }
    strip.classList.toggle('hidden', controller.tabs.length === 0);
  }
})();