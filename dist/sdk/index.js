import { createOtoolsAliasMap as S } from "./aliases.js";
import { otoolsTauriShimPlugin as v } from "./vite.js";
import { invoke as i } from "./runtime.js";
import { emit as T, getOtoolsApi as b, isOtoolsPluginRuntime as D, listen as L, openExternal as V, openPath as A } from "./runtime.js";
import { pickDirectory as K, pickFile as R, pickFiles as j, pickZipFile as q, saveFile as N } from "./dialog.js";
import { capture as z } from "./capture.js";
function s() {
  if (!(typeof window > "u"))
    return window.otools ?? window.utools;
}
async function c(o, e) {
  const t = String(o ?? "").trim();
  if (!t)
    return;
  const n = s();
  if (n?.shellOpen) {
    await n.shellOpen(t, e);
    return;
  }
  if (n?.shellOpenExternal && /^https?:\/\//i.test(t)) {
    n.shellOpenExternal(t);
    return;
  }
  if (n?.shellOpenPath) {
    n.shellOpenPath(t);
    return;
  }
  typeof window < "u" && window.open(t, "_blank", "noopener,noreferrer");
}
async function f(o) {
  const e = String(o ?? "").trim();
  if (!e)
    return;
  const t = s();
  if (t?.shellOpenPath) {
    t.shellOpenPath(e);
    return;
  }
}
async function u(o) {
  const e = String(o ?? "").trim();
  if (!e)
    return;
  const t = s();
  if (t?.shellOpenExternal) {
    t.shellOpenExternal(e);
    return;
  }
  typeof window < "u" && window.open(e, "_blank", "noopener,noreferrer");
}
async function w(o) {
  return i("tools_webview_browse_dialog", { request: { path: o ?? "" } });
}
async function d(o) {
  const e = String(o ?? "").trim();
  if (!e)
    throw new Error("listHostDir requires path");
  return i("tools_webview_list_dir", { path: e });
}
async function O(o) {
  const e = String(o ?? "").trim();
  if (!e)
    throw new Error("readHostFile requires path");
  return i("tools_webview_read_file", { path: e });
}
const h = (o) => {
  const e = typeof window < "u" ? window.otools : void 0;
  return typeof e?.pickFromHostTree != "function" ? Promise.reject(new Error("宿主未提供 pickFromHostTree（需要 apiVersion >= 2）")) : e.pickFromHostTree(o);
}, m = "otools-keyword-dispatch", y = (o) => {
  const e = typeof window < "u" ? window.otools : void 0;
  return typeof e?.onOtoolsKeyword != "function" ? Promise.reject(new Error("宿主未提供 onOtoolsKeyword（需要 apiVersion >= 2）")) : e.onOtoolsKeyword(o);
}, E = "otools-open-file";
function g(o) {
  if (!o)
    return [];
  try {
    const t = new URLSearchParams(o).get("otoolsOpenFile");
    if (!t)
      return [];
    const n = JSON.parse(t);
    return Array.isArray(n) ? n.map((r) => String(r || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function F(o) {
  return o.map((e) => {
    const t = String(e || "").trim(), n = t.split(/[\\/]/), r = n[n.length - 1] || t, l = r.lastIndexOf("."), p = l > 0 ? r.slice(l + 1).toLowerCase() : "";
    return { path: t, name: r, ext: p };
  });
}
const _ = (o) => {
  const e = typeof window < "u" ? window.otools : void 0;
  return typeof e?.onOtoolsOpenFile != "function" ? Promise.reject(new Error("宿主未提供 onOtoolsOpenFile（需要 apiVersion >= 2）")) : e.onOtoolsOpenFile(o);
};
export {
  E as OTOOLS_FILE_DELIVER_EVENT,
  m as OTOOLS_KEYWORD_DISPATCH_EVENT,
  w as browseHostDir,
  z as capture,
  S as createOtoolsAliasMap,
  T as emit,
  b as getOtoolsApi,
  i as invoke,
  D as isOtoolsPluginRuntime,
  d as listHostDir,
  L as listen,
  y as onOtoolsKeyword,
  _ as onOtoolsOpenFile,
  V as openExternal,
  A as openPath,
  v as otoolsTauriShimPlugin,
  g as parseLaunchOpenFiles,
  K as pickDirectory,
  R as pickFile,
  j as pickFiles,
  h as pickFromHostTree,
  q as pickZipFile,
  O as readHostFile,
  N as saveFile,
  c as shellOpen,
  u as shellOpenExternal,
  f as shellOpenPath,
  F as toOpenFileEntries
};
//# sourceMappingURL=index.js.map
