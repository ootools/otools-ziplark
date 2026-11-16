/* Local stand-in for @tauri-apps/plugin-dialog.
 *
 * IMPORTANT: this must never reach the OS native picker. The vendored SDK's
 * dialog.js imports open/save from this module at load time; routing those
 * calls back into the host bridge keeps every file selection inside the
 * in-page DOM tree supplied by otools-plugin-sdk.
 */
function bridge() {
  return (typeof window !== 'undefined' && window.__ZIPLARK_HOST__) || null;
}

export async function open(options) {
  var host = bridge();
  if (!host) return options && options.multiple ? [] : null;
  return host.open(options || {});
}

export async function save(options) {
  var host = bridge();
  if (!host) return null;
  return host.save(options || {});
}

export async function ask() { return false; }
export async function confirm() { return false; }
export async function message() { return undefined; }
