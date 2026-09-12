// ---------------- HTTP 基础: CORS / JSON 响应 ----------------

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Token, X-Admin-Token",
  "Access-Control-Max-Age": "86400"
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...headers }
  });
}
