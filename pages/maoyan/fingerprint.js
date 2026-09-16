(function (root) {
  async function collectEnrollmentFingerprint({ ThumbmarkClass }) {
    if (typeof ThumbmarkClass !== "function") throw new Error("浏览器标识组件不可用");
    const instance = new ThumbmarkClass({ logging: false, timeout: 3000 });
    const { thumbmark, error } = await instance.get();
    if (!/^[a-f0-9]{16,128}$/i.test(thumbmark || "") || error?.some((item) => item?.type === "fatal")) {
      const failure = new Error("浏览器标识暂不可用，请稍后重试");
      failure.code = "FINGERPRINT_UNAVAILABLE";
      throw failure;
    }
    return { fingerprint: thumbmark, version: "thumbmark-1.11.0-v1" };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { collectEnrollmentFingerprint };
  if (root) root.collectEnrollmentFingerprint = collectEnrollmentFingerprint;
})(typeof window !== "undefined" ? window : globalThis);
