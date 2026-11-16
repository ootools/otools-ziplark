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

  /* ---- OS "open with" / file association delivery ----
   * plugin.json declares `fileAssociations`; the host routes a double-clicked
   * archive to us via `otools-open-file` + `otools_consume_open_files`.
   * Everything is funnelled through the native layer's `push_open_file`, which
   * both queues a `ziplark-open-file` poll event and stores the startup
   * fallback path for `take_pending_file()`. Emulating the event locally here
   * would bypass that fallback and lose a cold-start delivery.
   */
  async function startOpenFileDelivery() {
    try {
      var sdk = await import('./sdk/index.js');
      if (typeof sdk.onOtoolsOpenFile !== 'function') return;
      await sdk.onOtoolsOpenFile(function (files) {
        (files || []).forEach(function (file) {
          if (!file || !file.path) return;
          invoke('push_open_file', { path: file.path }).catch(function (error) {
            log('push_open_file failed: ' + String(error && error.message || error));
          });
        });
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
})();
