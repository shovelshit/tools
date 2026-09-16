const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../../pages/maoyan");
const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

function proxyPath(pathname) {
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
          },
          body,
        });
        const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
        response.writeHead(upstreamResponse.status, {
          "Content-Type": upstreamResponse.headers.get("content-type") || "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(bytes);
        return;
      }
      let relative = url.pathname === "/" || url.pathname === "/maoyan/" ? "index.html" : url.pathname.replace(/^\/maoyan\//, "");
      if (!/^[\w.-]+$/.test(relative)) {
        response.writeHead(404).end();
        return;
      }
      const file = path.join(ROOT, relative);
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
