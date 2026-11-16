/*!
 * File picker adapter for the Ziplark OTools plugin.
 *
 * Hard rule: NEVER call the OS native picker. On macOS the OTools PANEL window
 * is a non-activating NSPanel with an Accessory activation policy; rfd's
 * blocking picker attaches a sheet to that panel and the panel's focus-loss
 * auto-hide dismisses it immediately (and leaves AppKit's modal state broken,
 * so no later picker opens either). See docs/host-file-picker.md.
 *
 * Instead we use the host SDK's in-page DOM tree (`pickFromHostTree`), which
 * talks to `tools_webview_browse_dialog` / `list_dir` and returns real host
 * filesystem paths. "Save as" adds only a filename prompt on top of it.
 */
import { pickFromHostTree, invoke as hostInvoke } from './sdk/index.js';

function basename(value) {
  return String(value || '').split(/[\\/]/).pop() || '';
}

function dirname(value) {
  var text = String(value || '').replace(/[\\/]+$/, '');
  var index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return index > 0 ? text.slice(0, index) : '';
}

function normalizeFilters(filters) {
  if (!Array.isArray(filters)) return undefined;
  var out = filters
    .filter(function (item) { return item && Array.isArray(item.extensions); })
    .map(function (item) {
      return { name: String(item.name || ''), extensions: item.extensions.map(String) };
    });
  return out.length ? out : undefined;
}

/**
 * Drop-in replacement for `@tauri-apps/plugin-dialog` open().
 * Returns a string for single select, a string[] for multiple, null on cancel.
 */
export async function openDialog(options) {
  var result;
  try {
    result = await pickFromHostTree({
      title: options.title || '选择文件',
      directory: !!options.directory,
      multiple: !!options.multiple,
      startPath: dirname(options.defaultPath) || undefined,
      filters: normalizeFilters(options.filters),
      showHidden: false,
    });
  } catch (error) {
    window.__ZIPLARK_HOST__?.log('pickFromHostTree failed: ' + String(error && error.message || error));
    return null;
  }
  if (!result || result.kind !== 'picked' || !Array.isArray(result.paths) || !result.paths.length) {
    return null;
  }
  return options.multiple ? result.paths.slice() : result.paths[0];
}

async function joinPath(dir, name) {
  var parts = [String(dir || '').replace(/[\\/]+$/, ''), String(name || '').replace(/^[\\/]+/, '')];
  // The host command knows the platform separator; fall back to a best guess
  // when running on an older host that does not expose it.
  for (var command of ['tools_webview_join_path', 'tools_webview_join_paths']) {
    try {
      var joined = await hostInvoke(command, { parts: parts });
      if (typeof joined === 'string' && joined) return joined;
    } catch (_) {
      /* try the next spelling */
    }
  }
  var separator = /\\/.test(parts[0]) && !/\//.test(parts[0]) ? '\\' : '/';
  return parts[0] + separator + parts[1];
}

/** A tiny filename prompt. The directory itself is always chosen via the SDK tree. */
function askFileName(title, initialName, directory) {
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'zl-save-overlay';
    overlay.innerHTML = [
      '<div class="zl-save-card" role="dialog" aria-modal="true">',
      '  <h3></h3>',
      '  <p class="zl-save-dir"></p>',
      '  <label class="zl-save-label"><span>文件名</span><input type="text" spellcheck="false" /></label>',
      '  <div class="zl-save-actions">',
      '    <button type="button" data-act="cancel" class="ghost">取消</button>',
      '    <button type="button" data-act="confirm" class="primary">保存</button>',
      '  </div>',
      '</div>',
    ].join('');
    overlay.querySelector('h3').textContent = title || '保存为…';
    overlay.querySelector('.zl-save-dir').textContent = directory || '';
    var input = overlay.querySelector('input');
    input.value = initialName || 'archive.zip';

    var done = function (value) {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    var confirm = function () {
      var name = String(input.value || '').trim();
      if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
        input.focus();
        input.select();
        return;
      }
      done(name);
    };
    var onKey = function (event) {
      if (event.key === 'Escape') { event.preventDefault(); done(null); }
      if (event.key === 'Enter') { event.preventDefault(); confirm(); }
    };

    overlay.querySelector('[data-act="cancel"]').addEventListener('click', function () { done(null); });
    overlay.querySelector('[data-act="confirm"]').addEventListener('click', confirm);
    overlay.addEventListener('mousedown', function (event) {
      if (event.target === overlay) done(null);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    input.focus();
    var dot = initialName ? initialName.lastIndexOf('.') : -1;
    input.setSelectionRange(0, dot > 0 ? dot : initialName.length);
  });
}

/**
 * Drop-in replacement for `@tauri-apps/plugin-dialog` save().
 * Choose a directory in the SDK tree, then ask for the filename.
 */
export async function saveDialog(options) {
  var result;
  try {
    result = await pickFromHostTree({
      title: '选择保存位置',
      directory: true,
      multiple: false,
      startPath: dirname(options.defaultPath) || undefined,
      showHidden: false,
    });
  } catch (error) {
    window.__ZIPLARK_HOST__?.log('pickFromHostTree (save) failed: ' + String(error && error.message || error));
    return null;
  }
  if (!result || result.kind !== 'picked' || !result.paths || !result.paths.length) return null;
  var dir = result.paths[0];
  var name = await askFileName(options.title, basename(options.defaultPath) || 'archive.zip', dir);
  if (!name) return null;
  return joinPath(dir, name);
}
