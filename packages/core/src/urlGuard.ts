const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/**
 * Syntactic SSRF guard for user-entered source URLs: http(s) only, no credentials
 * in the authority, no localhost / private / link-local literal hosts.
 * Hostnames must still be re-checked after DNS resolution before any server-side fetch.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs are allowed");
  if (url.username || url.password) throw new Error("Credentials in URL authority are not allowed");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Local hosts are not allowed");
  }
  if (PRIVATE_V4.some((re) => re.test(host))) throw new Error("Private addresses are not allowed");
  if (host.includes(":") && (host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:"))) {
    throw new Error("Private addresses are not allowed");
  }
  return url;
}
