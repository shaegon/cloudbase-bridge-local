/**
 * Minimal structured logger. It never receives request bodies, headers or the
 * CloudBase API key by design, and additionally drops any field whose name
 * looks secret as a second line of defence.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_FIELD = /key|token|authorization|secret|password/i;

function safeValue(value) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return value;
  return undefined;
}

export function createLogger({ level = "info", stream = process.stderr } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  return function log(lvl, message, fields = {}) {
    if ((LEVELS[lvl] ?? LEVELS.info) < threshold) return;
    const record = { ts: new Date().toISOString(), level: lvl, msg: message };
    for (const [name, value] of Object.entries(fields ?? {})) {
      if (SECRET_FIELD.test(name)) continue;
      const safe = safeValue(value);
      if (safe !== undefined) record[name] = safe;
    }
    stream.write(`${JSON.stringify(record)}\n`);
  };
}

export const silentLogger = () => {};
