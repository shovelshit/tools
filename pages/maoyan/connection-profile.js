(function (root) {
  function webTokenKey(profileKey) {
    return `token:${encodeURIComponent(String(profileKey || "").replace(/\/$/, ""))}`;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { webTokenKey };
  if (root) root.webTokenKey = webTokenKey;
})(typeof window !== "undefined" ? window : globalThis);
