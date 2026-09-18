const SENSITIVE_KEY = /cookie|authorization|token|mtgsig|signature|(?:^|[._-])sig(?:$|[._-])|csrf|session|secret|password|^sign$|^key$/i;
const HEADERS = ["content-type", "server", "cf-mitigated", "cf-ray", "x-request-id", "x-correlation-id", "retry-after"];
const BODY_LIMIT = 16 * 1024;

export function sanitizeFailureText(text, secrets = []) {
  const session = { cookies: secrets.map(value => ({ value })) };
  return captureFailureDetail({ status: 0, headers: new Headers() }, String(text ?? ""), session).responseBody;
}

function sessionSecrets(session) {
  const values = (session.cookies || []).map(cookie => String(cookie.value || ""));
  function collect(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key) && typeof item === "string") values.push(item);
      else if (item && typeof item === "object") collect(item);
    }
  }
  collect(session);
  return [...new Set(values.filter(Boolean).flatMap(value => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length);
}

export function captureFailureDetail(response, text, session) {
  const secrets = sessionSecrets(session);
  function sanitizeText(value) {
    let clean = String(value);
    for (const secret of secrets) clean = clean.replaceAll(secret, "[redacted]");
    return clean
      .replace(/<(?:input|meta)\b[^>]*>/ig, tag => {
        const name = tag.match(/\b(?:name|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        if (!name || !SENSITIVE_KEY.test(name[1] || name[2] || name[3])) return tag;
        return tag.replace(/\b(value|content)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/ig, '$1="[redacted]"');
      })
      .replace(/https?:\/\/[^\s"'<>]+/ig, "[redacted-url]")
      .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/ig, "[redacted-auth]")
      .replace(/\b(?:set-cookie|cookie|authorization)\s*[:=]\s*[^\r\n<]+/ig, "[redacted-header]")
      .replace(/<([\w:.-]*(?:token|cookie|signature|mtgsig|csrf|password|secret)[\w:.-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/ig, "<$1>[redacted]</$1>")
      .replace(/([\w.-]*(?:token|cookie|authorization|signature|mtgsig|csrf|session|password|secret)[\w.-]*|\bsign|\bsig)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,<>}&]+)/ig, "$1=[redacted]");
  }
  function sanitizeValue(value, depth = 0) {
    if (depth > 64) return "[redacted-depth-limit]";
    if (Array.isArray(value)) return value.map(item => sanitizeValue(item, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      sanitizeText(key), SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeValue(item, depth + 1)
    ]));
    return typeof value === "string" ? sanitizeText(value) : value;
  }
  let body;
  try { body = JSON.stringify(sanitizeValue(JSON.parse(text))); }
  catch { body = sanitizeText(text); }
  const bytes = new TextEncoder().encode(body);
  const bodyTruncated = bytes.length > BODY_LIMIT;
  // Streaming decode drops an incomplete final UTF-8 sequence at the byte boundary.
  const responseBody = bodyTruncated
    ? new TextDecoder().decode(bytes.subarray(0, BODY_LIMIT), { stream: true }) : body;
  const headers = Object.fromEntries(HEADERS.flatMap(name => {
    const value = response.headers.get(name);
    return value === null ? [] : [[name, sanitizeText(value).slice(0, 512)]];
  }));
  return { httpStatus: response.status, headers, responseBody, bodyTruncated };
}
