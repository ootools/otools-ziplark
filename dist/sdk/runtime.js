const c = { kind: "Any" }, o = () => {
  if (!(typeof window > "u"))
    return window.otools ?? window.utools;
}, v = () => !!o(), s = () => typeof window > "u" ? void 0 : window.__TAURI_INTERNALS__, f = (n) => n && typeof n == "object" && "payload" in n ? n.payload : n;
async function w(n, e) {
  const t = s();
  if (!t?.invoke)
    throw new Error("Tauri runtime is unavailable");
  return t.invoke(n, e);
}
async function k(n, e) {
  const t = o();
  if (typeof t?.invoke != "function")
    throw new Error("宿主未提供 otools.invoke（需要 apiVersion >= 2）");
  return t.invoke(n, e);
}
async function d(n, e, t = {}) {
  const i = s();
  if (!i?.invoke || !i.transformCallback)
    throw new Error("Tauri event runtime is unavailable");
  let a = !0;
  const u = i.transformCallback((r) => {
    a && e({
      event: n,
      id: r && typeof r == "object" && "id" in r ? Number(r.id) : -1,
      payload: f(r)
    });
  }, !1);
  let l;
  try {
    l = await i.invoke("plugin:event|listen", {
      event: n,
      target: typeof t.target == "string" ? { kind: "AnyLabel", label: t.target } : t.target ?? c,
      handler: u
    });
  } catch (r) {
    throw i.unregisterCallback?.(u), r;
  }
  return async () => {
    if (a) {
      a = !1;
      try {
        await window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener?.(n, l);
      } catch {
      }
      i.unregisterCallback?.(u), await i.invoke("plugin:event|unlisten", { event: n, eventId: l });
    }
  };
}
async function p(n, e, t = {}) {
  return d(n, e, t);
}
async function y(n, e) {
  await w("plugin:event|emit", { event: n, payload: e ?? null });
}
function T(n) {
  const e = o();
  return !e || typeof e.shellOpenExternal != "function" ? !1 : (e.shellOpenExternal(n), !0);
}
function g(n) {
  const e = o();
  return !e || typeof e.openPath != "function" ? !1 : e.openPath(n);
}
export {
  y as emit,
  o as getOtoolsApi,
  k as invoke,
  w as invokeTauri,
  v as isOtoolsPluginRuntime,
  p as listen,
  d as listenTauri,
  T as openExternal,
  g as openPath
};
//# sourceMappingURL=runtime.js.map
