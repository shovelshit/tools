import test from "node:test";
import assert from "node:assert/strict";
import {
  MODULES,
  canonicalModulePath,
  canonicalStorePath,
  isModuleHost
} from "../src/common/module-routes.js";

test("registers the canonical Movie and Store module hosts", () => {
  assert.equal(MODULES.movie.host, "movie.ltools.asia");
  assert.equal(MODULES.store.host, "store.ltools.asia");
  assert.equal(isModuleHost(new URL("https://movie.ltools.asia/"), "movie"), true);
  assert.equal(isModuleHost(new URL("https://ltools.asia/maoyan/"), "movie"), false);
});

test("maps Movie subdomain root paths to the existing static asset prefix", () => {
  assert.equal(canonicalModulePath(new URL("https://movie.ltools.asia/"), "movie"), "/maoyan/");
  assert.equal(canonicalModulePath(new URL("https://movie.ltools.asia/download.html"), "movie"), "/maoyan/download.html");
  assert.equal(canonicalModulePath(new URL("https://ltools.asia/maoyan/"), "movie"), "/maoyan/");
});

test("maps Store subdomain root and service paths to the existing Store prefix", () => {
  assert.equal(canonicalStorePath(new URL("https://store.ltools.asia/")), "/store/");
  assert.equal(canonicalStorePath(new URL("https://store.ltools.asia/auth/session")), "/store/auth/session");
  assert.equal(canonicalStorePath(new URL("https://store.ltools.asia/api/fs/list")), "/store/api/fs/list");
  assert.equal(canonicalStorePath(new URL("https://store.ltools.asia/store/api/fs/list")), "/store/api/fs/list");
  assert.equal(canonicalStorePath(new URL("https://ltools.asia/store/")), "/store/");
});
