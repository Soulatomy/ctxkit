import http from "node:http";

export interface LocalServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Tiny localhost HTTP server used by the self-check.
 *
 * Why an HTTP origin instead of about:blank / data: URLs:
 *  - patchright injects init scripts via network routes (to avoid Runtime.enable),
 *    so non-HTTP documents (about:blank, data:, file:) never receive the script;
 *  - localhost is a "trustworthy" origin, so secure-context APIs like
 *    navigator.userAgentData are present, matching a real page.
 */
export async function startLocalPageServer(
  html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>fb-check</title></head><body></body></html>",
): Promise<LocalServer> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        // Chromium may hold a keep-alive socket; server.close() alone would
        // wait on it for minutes. Force-drop connections before closing.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
