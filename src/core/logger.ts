/** Minimal structured logger so engines/CLI share one output format. */
type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 1;

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (ORDER[level] < threshold) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} (${scope}) ${msg}`;
  const sink = level === "error" ? console.error : console.log;
  if (extra === undefined) sink(line);
  else sink(line, extra);
}

export const log = {
  debug: (s: string, m: string, e?: unknown) => emit("debug", s, m, e),
  info: (s: string, m: string, e?: unknown) => emit("info", s, m, e),
  warn: (s: string, m: string, e?: unknown) => emit("warn", s, m, e),
  error: (s: string, m: string, e?: unknown) => emit("error", s, m, e),
};
