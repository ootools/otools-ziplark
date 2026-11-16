/*!
 * Ziplark 归档多标签（TABS）：控制器核心 + DOM 接线。
 *
 * 设计：docs/tabs-design.md（v2，PATCH 方案）。main.js 的三个状态变量是脚本作用域
 * let/const，构建补丁（scripts/build-web.mjs 的 MAIN_PATCH_*）注入 `window.__ztState`
 * 读写出口；本文件运行时包装全局函数 openArchive/closeArchive/renderArchive，注入
 * 标签条 DOM。上游 `upstream/ui/` 快照不改。
 *
 * 纯逻辑（createController，依赖注入）与 DOM 胶水分离；测试经 `__ztTabsTest__`
 * 驱动核心（scripts/tabs.test.mjs，node:vm、无 DOM 环境）。
 */
(function () {
  'use strict';

  /* ---------- 控制器核心（依赖注入，可单测） ---------- */

  function copyArchive(value) {
    return value ? Object.assign({}, value) : null;
  }

  /**
   * @param deps {state, getUi, setUi, render(info), refresh(path, keepStack, pw),
   *              closeCurrent(), switchViewOpen()}
   *   - state：构建补丁注入的 `__ztState`（get/set currentArchive/stack、get tree）。
   *   - getUi/setUi：树视图状态的读与恢复（expanded/sortBy/sortAsc/query/scrollTop）。
   *   - refresh：原始 `openArchive`（重新 list + render）。
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

    /**
     * 打开入口（包装 openArchive 的落点）：
     *  - 同 path 已有 tab → 激活既有 tab（等价刷新）；
     *  - 新 path → 新建 tab 并激活；
     *  - keepStack（嵌套钻取）→ 不建 tab，栈归属当前 tab。
     * refresh 完成后由接线层调用 snapshotActive 落盘。
     */
    function openTab(path, options) {
      const opts = options || {};
      const normalized = String(path || '').trim();
      if (!normalized) return null;
      if (opts.keepStack) {
        deps.refresh(normalized, true, opts.initialPassword ?? null);
        return byId(activeId);
      }
      let tab = byPath(normalized);
      if (!tab) {
        tab = {id: ++seq, path: normalized, archive: null, stack: [], info: null, ui: null};
        tabs.push(tab);
      }
      snapshotActive();
      activeId = tab.id;
      deps.refresh(normalized, false, opts.initialPassword ?? null);
      return tab;
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
    },
    render: (info) => originalRenderArchive(info),
    refresh: (path, keepStack, initialPassword) => {
      lastRefreshPromise = originalOpenArchive(path, keepStack, initialPassword);
      return lastRefreshPromise;
    },
    closeCurrent: () => originalCloseArchive(),
    switchViewOpen: () => window.switchView('open'),
  });

  let lastRefreshPromise = null;

  /* 包装上游全局函数：函数声明挂 window，main.js 内部调用同样命中包装版。 */
  window.renderArchive = function (info) {
    controller.setActiveInfo(info);
    return originalRenderArchive(info);
  };

  window.openArchive = function (path, keepStack, initialPassword) {
    controller.openTab(path, {keepStack: keepStack === true, initialPassword: initialPassword ?? null});
    Promise.resolve(lastRefreshPromise)
      .then(() => {
        controller.snapshotActive();
        renderStrip();
      })
      .catch(() => {
        // 打开失败（toast 已由上游提示）：本次新建且无内容的 tab 回收；
        // 既有 tab 保留旧状态（重列失败不影响它）。
        const active = controller.tabs.find((t) => t.id === controller.activeId);
        if (active && !active.info) {
          controller.closeTab(active.id);
        }
        renderStrip();
      });
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
  openBtn.title = '打开归档';
  openBtn.textContent = '＋ 打开归档';
  openBtn.addEventListener('click', () => {
    const btn = $('btn-open');
    if (btn) btn.click();
  });
  strip.appendChild(openBtn);
  const tabItems = document.createElement('div');
  tabItems.className = 'zt-tab-items';
  strip.appendChild(tabItems);
  const topbar = document.querySelector('.topbar');
  if (topbar && topbar.parentNode) {
    topbar.parentNode.insertBefore(strip, topbar.nextSibling);
  }

  function renderStrip() {
    tabItems.textContent = '';
    for (const tab of controller.tabs) {
      const el = document.createElement('div');
      el.className = 'zt-tab' + (tab.id === controller.activeId ? ' active' : '');
      el.title = tab.path;
      const name = document.createElement('span');
      name.className = 'zt-tab-name';
      name.textContent = basename(tab.path);
      name.addEventListener('click', () => controller.activateTab(tab.id));
      el.appendChild(name);
      const close = document.createElement('span');
      close.className = 'zt-close';
      close.textContent = '×';
      close.title = '关闭';
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        controller.closeTab(tab.id);
        renderStrip();
      });
      el.appendChild(close);
      tabItems.appendChild(el);
    }
    strip.classList.toggle('hidden', controller.tabs.length === 0);
  }
})();
