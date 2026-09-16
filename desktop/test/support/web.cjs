const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../../pages/maoyan");
const STORE_ROOT = path.resolve(__dirname, "../../../pages/store");
const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".webp", "image/webp"],
]);

function proxyPath(pathname) {
  if (pathname.startsWith("/store/auth/") || pathname.startsWith("/store/api/") || pathname === "/store/file") return pathname;
  if (pathname.startsWith("/one/api/")) return pathname;
  if (pathname.startsWith("/api/")) return `/one${pathname}`;
  return "";
}

async function startWebFixture({ workerUrl }) {
  const upstream = String(workerUrl || "").replace(/\/+$/, "");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(upstream)) throw new Error("Web fixture requires a loopback mock Worker");
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://fixture.local");
      const proxied = proxyPath(url.pathname);
      if (proxied) {
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : await new Promise((resolve, reject) => {
          const chunks = [];
          request.on("data", (chunk) => chunks.push(chunk));
          request.on("end", () => resolve(Buffer.concat(chunks)));
          request.on("error", reject);
        });
        const upstreamResponse = await fetch(`${upstream}${proxied}${url.search}`, {
          method: request.method,
          headers: {
            ...(request.headers["x-token"] ? { "X-Token": request.headers["x-token"] } : {}),
            ...(request.headers["content-type"] ? { "Content-Type": request.headers["content-type"] } : {}),
            ...(request.headers.cookie ? { Cookie: request.headers.cookie } : {}),
            ...(request.headers.origin ? { Origin: `${url.protocol}//${request.headers.host}` } : {}),
          },
          body,
        });
        const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
        response.writeHead(upstreamResponse.status, {
          "Content-Type": upstreamResponse.headers.get("content-type") || "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...(upstreamResponse.headers.get("set-cookie") ? { "Set-Cookie": upstreamResponse.headers.get("set-cookie") } : {}),
          ...(upstreamResponse.headers.get("content-disposition") ? { "Content-Disposition": upstreamResponse.headers.get("content-disposition") } : {}),
        });
        response.end(bytes);
        return;
      }
      const store = url.pathname === "/store/" || url.pathname.startsWith("/store/");
      const root = store ? STORE_ROOT : ROOT;
      let relative = url.pathname === "/" || url.pathname === "/maoyan/" || url.pathname === "/store/"
        ? "index.html"
        : url.pathname.replace(store ? /^\/store\// : /^\/maoyan\//, "");
      if (!/^[\w./-]+$/.test(relative) || relative.split("/").includes("..")) {
        response.writeHead(404).end();
        return;
      }
      const file = path.resolve(root, relative);
      if (!file.startsWith(`${root}${path.sep}`)) {
        response.writeHead(404).end();
        return;
      }
      const bytes = await fs.readFile(file);
      response.writeHead(200, {
        "Content-Type": MIME.get(path.extname(file)) || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error?.code === "ENOENT" ? "Not found" : "Fixture error");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

module.exports = { startWebFixture };
