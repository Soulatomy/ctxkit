/**
 * Proxy model. `country` is the ISO-3166 alpha-2 code used for geo-consistency:
 * the fingerprint's timezone / locale / languages must line up with the exit IP,
 * otherwise a mismatch is itself a signal.
 */
export interface ProxyConfig {
  /** e.g. "http://1.2.3.4:8080" or "socks5://host:1080" */
  server: string;
  username?: string;
  password?: string;
  /** ISO alpha-2, e.g. "US", "GB", "DE". Drives timezone/locale coherence. */
  country?: string;
  /** Force a specific IANA timezone; otherwise derived from country. */
  timezone?: string;
}

export function describeProxy(p?: ProxyConfig): string {
  if (!p) return "direct";
  try {
    const u = new URL(p.server);
    return `${u.protocol}//${u.hostname}:${u.port}${p.country ? ` [${p.country}]` : ""}`;
  } catch {
    return p.server;
  }
}

/** Playwright-shaped proxy object. */
export function toPlaywrightProxy(p: ProxyConfig) {
  return {
    server: p.server,
    username: p.username,
    password: p.password,
  };
}
