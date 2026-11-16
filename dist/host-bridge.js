/*!
 * OTools host bridge for Ziplark.
 *
 * Injected BEFORE upstream ui/main.js as a classic (non-module) script, because
 * the upstream frontend reads `window.__TAURI__` at top level. Everything that
 * needs the ESM SDK is loaded lazily with `import()` from dialogs.js / runtime.js.
 *
 * Three responsibilities:
 *   - core.invoke  -> window.otools.invokeNative (the plugin cdylib)
 *   - dialog       -> otools-plugin-sdk `pickFromHostTree` (in-page DOM tree)
 *   - event.listen -> native plugin poll_events + Tauri drag/drop + open-file
 */
(function () {
  'use strict';

  var listeners = new Map();
  var started = false;
  var dragDedupe = new Map();
  // Paths already delivered through the `ziplark-open-file` event. The upstream
  // UI also calls `take_pending_file()` once at startup; without this set the
  // same archive would be opened twice for a cold-start delivery.
  var deliveredOpenPaths = new Set();

  function hostApi() {
    return window.otools || window.utools || null;
  }

  function emitLocal(name, payload) {
    var set = listeners.get(name);
    if (!set) return;
    Array.from(set).forEach(function (fn) {
      try {
        fn({ event: name, id: -1, payload: payload });
      } catch (error) {
        console.warn('[ziplark] listener failed for ' + name, error);
      }
    });
  }

  function log(message) {
    try {
      var internals = window.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === 'function') {
        internals.invoke('tools_webview_log', { message: '[ziplark] ' + message }).catch(function () {});
      }
    } catch (_) {
      /* diagnostics must never break the UI */
    }
  }

  async function nativeInvoke(command, args) {
    // Upstream installs a very chatty pointer-event selftest logger. It is a
    // no-op in release builds, so drop it instead of crossing the FFI boundary
    // on every click.
    if (command === 'selftest_log' || command === 'selftest_action') return null;
    var api = hostApi();
    if (!api || typeof api.invokeNative !== 'function') {
      throw new Error('Ziplark must run inside OTools (native bridge unavailable)');
    }
    return api.invokeNative(command, args || {});
  }

  async function invoke(command, args) {
    if (command === 'take_pending_file') {
      // Cold-start fallback: the native layer keeps the last file the host
      // handed us. Suppress it when the event channel already opened it.
      var pending = await nativeInvoke('take_pending_file', args || {});
      if (typeof pending === 'string' && pending && deliveredOpenPaths.has(pending)) return null;
      return pending;
    }
    return nativeInvoke(command, args);
  }

  function webviewLabel() {
    try {
      return window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label || '';
    } catch (_) {
      return '';
    }
  }

  function windowLabel() {
    try {
      return window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label || '';
    } catch (_) {
      return '';
    }
  }

  /* ---- native plugin events: progress + open-file ---- */
  async function startNativeEvents() {
    var api = hostApi();
    if (!api || typeof api.listenNative !== 'function') return;
    try {
      await api.listenNative(function (event) {
        var body = event && event.payload;
        if (!body || typeof body.topic !== 'string') return;
        if (body.topic === 'ziplark-open-file' && typeof body.payload === 'string') {
          deliveredOpenPaths.add(body.payload);
          if (deliveredOpenPaths.size > 256) deliveredOpenPaths.clear();
        }
        emitLocal(body.topic, body.payload);
      }, { intervalMs: 100 });
    } catch (error) {
      log('listenNative unavailable: ' + String(error && error.message || error));
    }
  }

  /* ---- open-file delivery helpers ----
   * 统一投递出口：三个来源（URL 参数兜底、启动期 consume、敲门 consume）都汇入
   * deliverOpenPath，5 秒滑动窗口去重后 emitLocal 本地打开——不再走
   * push_open_file → poll_events 全局广播（多表面会各开一次）。去重窗口的代价：
   * 5 秒内刻意重开同一文件会被忽略，此时 UI 本来就显示着它。
   */
  var recentDeliveries = new Map();
  var DELIVER_DEDUPE_WINDOW_MS = 5000;

  function normalizePluginUuidFromLabel(label) {
    var raw = String(label || '').trim();
    if (!raw) return '';
    var splitAt = raw.lastIndexOf(':');
    if (splitAt <= 0 || splitAt >= raw.length - 1) return raw;
    // 宿主 label 形如 `tools-tab-plugin-market:otools-ziplark` / `panel-plugin-market:…`：
    // 先剥表面前缀再按 source:uuid 归一化（对齐宿主 normalizeRuntimePluginUuid 的白名单）。
    var source = raw.slice(0, splitAt).trim().toLowerCase()
      .replace(/^(tools-tab-plugin-|panel-plugin-|plugin-)/, '');
    var pluginId = raw.slice(splitAt + 1).trim();
    if (source === 'builtin' || source === 'market' || source === 'dev-debug' || source === 'dev-workspace') {
      return pluginId;
    }
    return raw;
  }

  function resolvePluginUuid() {
    try {
      var env = window.__OToolsEnv;
      var fromEnv = env && typeof env.pluginUuid === 'string' ? env.pluginUuid.trim() : '';
      if (fromEnv) return fromEnv;
    } catch (_) {
      /* fall through to the label */
    }
    return normalizePluginUuidFromLabel(webviewLabel());
  }

  function pruneRecentDeliveries(now) {
    recentDeliveries.forEach(function (seenAt, delivered) {
      if (now - seenAt >= DELIVER_DEDUPE_WINDOW_MS) recentDeliveries.delete(delivered);
    });
  }

  function deliverOpenPath(path) {
    var value = String(path || '').trim();
    if (!value) return;
    var now = Date.now();
    pruneRecentDeliveries(now);
    var seenAt = recentDeliveries.get(value);
    if (typeof seenAt === 'number' && now - seenAt < DELIVER_DEDUPE_WINDOW_MS) return;
    recentDeliveries.set(value, now);
    emitLocal('ziplark-open-file', value);
  }

  /** SDK onOtoolsOpenFile 的回调（URL 参数 + 启动期 consume）：本地投递，不再 push。 */
  function handleOtoolsOpenFile(files) {
    (files || []).forEach(function (file) {
      if (!file || !file.path) return;
      deliverOpenPath(file.path);
    });
  }

  /** 敲门后取走投给自己的文件列表。走 wrapped `otools.invoke`：native 先报
   * Unknown method、命中回落标记后自动落到宿主命令（老宿主 dylib 无此方法）。 */
  async function consumeOpenFiles() {
    var api = hostApi();
    if (!api || typeof api.invoke !== 'function') {
      log('consume_open_files skipped: otools.invoke unavailable');
      return;
    }
    var uuid = resolvePluginUuid();
    if (!uuid) return;
    try {
      var paths = await api.invoke('otools_consume_open_files', {pluginUuid: uuid});
      (Array.isArray(paths) ? paths : []).forEach(function (path) {
        deliverOpenPath(path);
      });
    } catch (error) {
      log('consume_open_files failed: ' + String(error && error.message || error));
    }
  }

  /** 敲门监听 target：与拖拽（startDragEvents）同一套兜底策略。宿主 emit_to 的
   * AnyLabel 只匹配带 label 的监听器，默认 Any 永远收不到——这正是本修复的根因。 */
  function knockListenerTargets() {
    var webview = webviewLabel();
    var win = windowLabel();
    var targets = [];
    if (webview) targets.push({kind: 'Webview', label: webview});
    if (win && win !== webview) targets.push({kind: 'Window', label: win});
    if (!targets.length) targets.push({kind: 'Any'});
    return targets;
  }

  async function startKnockListener() {
    try {
      var rt = await import('./sdk/runtime.js');
      if (typeof rt.listenTauri !== 'function') return;
      // 事件名与 SDK 的 OTOOLS_FILE_DELIVER_EVENT 对齐（宿主 emit_to("otools-open-file")）。
      var jobs = knockListenerTargets().map(function (target) {
        return rt.listenTauri('otools-open-file', function () {
          void consumeOpenFiles();
        }, {target: target}).catch(function (error) {
          log('knock listener -> ' + target.kind + ' failed: ' + String(error));
        });
      });
      await Promise.all(jobs);
    } catch (error) {
      log('knock listener unavailable: ' + String(error && error.message || error));
    }
  }

  /* ---- OS "open with" / file association delivery ----
   * plugin.json declares `fileAssociations`; the host routes a double-clicked
   * archive to us via `otools-open-file` + `otools_consume_open_files`.
   * 两条来源（SDK 工厂回调：URL 参数 + 启动期 consume；以及敲门直连监听）都汇入
   * deliverOpenPath 本地投递——push_open_file → poll_events 广播链已退役
   * （多表面会各开一次），dylib 的方法保留但闲置。
   */
  async function startOpenFileDelivery() {
    try {
      var sdk = await import('./sdk/index.js');
      if (typeof sdk.onOtoolsOpenFile !== 'function') return;
      await sdk.onOtoolsOpenFile(function (files) {
        handleOtoolsOpenFile(files);
      });
    } catch (error) {
      log('onOtoolsOpenFile unavailable: ' + String(error && error.message || error));
    }
  }

  /* ---- OS drag & drop ----
   * The host's wry drag_drop_handler intercepts native drops (so HTML5
   * dataTransfer.files is empty), but Tauri re-emits `tauri://drag-*` to the
   * child webview with the real filesystem paths. Register with a Webview
   * target; the SDK's default `Any` target does not match `emit_to_webview`.
   */
  async function startDragEvents() {
    try {
      var rt = await import('./sdk/runtime.js');
      if (typeof rt.listenTauri !== 'function') return;
      var webview = webviewLabel();
      var win = windowLabel();
      var targets = [];
      if (webview) targets.push({ kind: 'Webview', label: webview });
      if (win && win !== webview) targets.push({ kind: 'Window', label: win });
      if (!targets.length) targets.push({ kind: 'Any' });

      var events = ['tauri://drag-enter', 'tauri://drag-over', 'tauri://drag-leave', 'tauri://drag-drop'];
      var jobs = [];
      events.forEach(function (name) {
        targets.forEach(function (target) {
          jobs.push(
            rt.listenTauri(name, function (event) {
              // A Window-target listener may receive the same physical drop as
              // the Webview-target one. Collapse duplicates by event id + paths.
              if (name === 'tauri://drag-drop') {
                var paths = (event && event.payload && event.payload.paths) || [];
                var key = String(event && event.id) + '|' + paths.join('|');
                var now = Date.now();
                if (dragDedupe.has(key) && now - dragDedupe.get(key) < 500) return;
                dragDedupe.set(key, now);
                if (dragDedupe.size > 64) {
                  dragDedupe.forEach(function (at, k) { if (now - at > 3000) dragDedupe.delete(k); });
                }
              }
              emitLocal(name, event ? event.payload : null);
            }, { target: target }).catch(function (error) {
              log('drag listener ' + name + ' -> ' + target.kind + ' failed: ' + String(error));
            })
          );
        });
      });
      await Promise.all(jobs);
    } catch (error) {
      log('drag/drop listener unavailable: ' + String(error && error.message || error));
    }
  }

  function ensureSubscriptions() {
    if (started) return;
    started = true;
    startNativeEvents();
    startOpenFileDelivery();
    startKnockListener();
    startDragEvents();
  }

  async function listen(event, handler) {
    if (typeof handler !== 'function') return async function () {};
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    ensureSubscriptions();
    return async function () {
      var set = listeners.get(event);
      if (set) set.delete(handler);
    };
  }

  /* ---- file pickers: never use the OS native dialog ---- */
  async function dialogOpen(options) {
    var mod = await import('./dialogs.js');
    return mod.openDialog(options || {});
  }

  async function dialogSave(options) {
    var mod = await import('./dialogs.js');
    return mod.saveDialog(options || {});
  }

  window.__TAURI__ = {
    core: { invoke: invoke },
    dialog: { open: dialogOpen, save: dialogSave },
    event: { listen: listen },
  };

  // Small helper also exposed for the SDK dialog shim, so a stray
  // `@tauri-apps/plugin-dialog` import can never reach the OS picker.
  window.__ZIPLARK_HOST__ = {
    invoke: invoke,
    open: dialogOpen,
    save: dialogSave,
    log: log,
  };

  // 纯逻辑测试钩子（node:vm 加载本文件后驱动）；宿主集成行为由端到端验证覆盖。
  window.__ZIPLARK_TEST__ = {
    normalizePluginUuidFromLabel: normalizePluginUuidFromLabel,
    resolvePluginUuid: resolvePluginUuid,
    deliverOpenPath: deliverOpenPath,
    recentDeliveries: recentDeliveries,
    handleOtoolsOpenFile: handleOtoolsOpenFile,
    consumeOpenFiles: consumeOpenFiles,
    knockListenerTargets: knockListenerTargets,
  };
})();
