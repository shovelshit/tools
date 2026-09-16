export function requireBusinessAccess(principal, businessLine) {
  if (!principal || (principal.role !== "admin" && principal.businessLine !== businessLine)) {
    const error = new Error("无权访问该业务");
    error.code = "FORBIDDEN";
    throw error;
  }
  return principal;
}
