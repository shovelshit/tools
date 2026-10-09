// Public module hosts map to the asset prefixes retained by the monorepo.
export const MODULES = Object.freeze({
  movie: Object.freeze({ host: "movie.ltools.asia", assetPrefix: "/maoyan" }),
  store: Object.freeze({ host: "store.ltools.asia", assetPrefix: "/store" })
});

function prefixed(prefix, pathname) {
  const path = pathname || "/";
  if (path === "/") return `${prefix}/`;
  return path.startsWith(`${prefix}/`) ? path : `${prefix}${path}`;
}

export function isModuleHost(url, name) {
  const module = MODULES[name];
  return Boolean(module && String(url?.hostname || "").toLowerCase() === module.host);
}

export function canonicalModulePath(url, name) {
  const module = MODULES[name];
  if (!module || !isModuleHost(url, name)) return url?.pathname || "/";
  return prefixed(module.assetPrefix, url.pathname);
}

export function canonicalStorePath(url) {
  const pathname = url?.pathname || "/";
  if (!isModuleHost(url, "store")) return pathname === "/store" ? "/store/" : pathname;
  return prefixed(MODULES.store.assetPrefix, pathname);
}
