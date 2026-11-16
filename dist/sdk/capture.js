const r = new Proxy({}, {
  get(n, e) {
    const t = typeof window < "u" ? window.otools?.capture : void 0, o = t?.[e];
    return typeof o != "function" ? o : o.bind(t);
  }
});
export {
  r as capture
};
//# sourceMappingURL=capture.js.map
