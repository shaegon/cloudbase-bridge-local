/**
 * Configuration and credential loading.
 *
 * Design choices that matter for security:
 * - There is deliberately no "gateway URL override": the CloudBase API key can
 *   only ever be sent to https://{envId}.api.tcloudbasegateway.com.
 * - The API key lives in its own file (or CLOUDBASE_API_KEY), never in
 *   config.json, so configs can be shared without leaking the key.
 * - Both files must be owner-only on POSIX systems; otherwise startup fails.
 */

import { readFile, stat, mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { validateReasoningParams } from "./reasoning.mjs";

export const VERSION = "0.1.0";
export const SERVICE = "cloudbase-bridge-local";
export const DEFAULT_FUNCTION = "aiProxy";
export const DEFAULT_PORT = 8788;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 150_000;
/** CloudBase caps a synchronous event at 6 MB. */
export const MAX_EVENT_BYTES = 6 * 1024 * 1024;

/** Metadata used by /v1/models. Unknown ids in config.models get sane defaults. */
export const MODEL_CATALOG = Object.freeze({
  "hy4-flash": { name: "Hunyuan 4 Flash", context: 1_000_000, output: 16_384, image: true },
  "hy4": { name: "Hunyuan 4", context: 1_000_000, output: 16_384, image: true },
  "hy4-preview": { name: "Hunyuan 4 Preview", context: 1_000_000, output: 16_384, image: true },
  "hy3": { name: "Hunyuan 3", context: 262_144, output: 16_384, image: false },
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", context: 1_000_000, output: 16_384, image: true },
  "deepseek-v4.1-flash-1017": { name: "DeepSeek V4.1 Flash 1017", context: 1_000_000, output: 16_384, image: true },
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidEnvId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(value);
}

export function isValidFunctionName(value) {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,58}[a-zA-Z0-9]$/.test(value);
}

export function defaultConfigDir(env = process.env) {
  const base =
    typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
      ? env.XDG_CONFIG_HOME.trim()
      : path.join(homedir(), ".config");
  return path.join(base, "cloudbase-bridge");
}

export function defaultConfigPath(env = process.env) {
  return path.join(defaultConfigDir(env), "config.json");
}

/**
 * Refuse files that other local users could read. On a single-user desktop
 * this mostly guards against accidental chmod/umask mistakes.
 */
export async function assertPrivateFile(file, label) {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error.code === "ENOENT") throw new ConfigError(`${label} not found: ${file}`);
    throw new ConfigError(`cannot stat ${label}: ${file}`);
  }
  if (!info.isFile()) throw new ConfigError(`${label} is not a regular file: ${file}`);
  if (process.platform !== "win32") {
    if ((info.mode & 0o077) !== 0) {
      throw new ConfigError(`${label} must not be group/other accessible: chmod 600 ${file}`);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new ConfigError(`${label} must be owned by the current user: ${file}`);
    }
  }
}

/**
 * A per-model entry may be the parameters themselves, or — for a model that
 * thinks unless it is told not to — a guarded form that only applies when the
 * request's own output budget is too small to hold thinking and an answer:
 *
 *   "hy4": { "when": { "maxTokensAtMost": 4096 }, "params": { "thinking": { "type": "disabled" } } }
 *
 * Without the guard, any small-budget request for that model (a host's
 * background classifier, say) spends its whole budget on reasoning and comes
 * back with no answer at all.
 */
function validateWhen(raw, label) {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${label}.when must be an object`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== "maxTokensAtMost") {
      throw new ConfigError(`${label}.when supports only "maxTokensAtMost"`);
    }
  }
  const limit = raw.maxTokensAtMost;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ConfigError(`${label}.when.maxTokensAtMost must be a positive integer`);
  }
  return Object.freeze({ maxTokensAtMost: limit });
}

export function validateConfig(raw, { configPath } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config must be a JSON object");
  }
  const envId = typeof raw.envId === "string" ? raw.envId.trim() : "";
  if (!isValidEnvId(envId)) {
    throw new ConfigError("envId must be 3-64 characters: letters, digits, - or _");
  }

  const functionName =
    typeof raw.functionName === "string" && raw.functionName.trim()
      ? raw.functionName.trim()
      : DEFAULT_FUNCTION;
  if (!isValidFunctionName(functionName)) {
    throw new ConfigError(
      "functionName must match ^[a-zA-Z][a-zA-Z0-9_-]{0,58}[a-zA-Z0-9]$",
    );
  }

  let region = "cn";
  if (raw.region !== undefined) {
    if (raw.region !== "cn" && raw.region !== "intl") {
      throw new ConfigError('region must be "cn" or "intl"');
    }
    region = raw.region;
  }

  const port = raw.port === undefined ? DEFAULT_PORT : raw.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new ConfigError("port must be an integer between 1024 and 65535");
  }

  const localToken = typeof raw.localToken === "string" ? raw.localToken.trim() : "";
  if (localToken.length < 32) {
    throw new ConfigError("localToken must be at least 32 characters; run `cloudbase-bridge init`");
  }

  const models = raw.models === undefined ? Object.keys(MODEL_CATALOG) : raw.models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new ConfigError("models must be a non-empty array of model ids");
  }
  const seen = new Set();
  for (const id of models) {
    if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      throw new ConfigError(`invalid model id: ${String(id).slice(0, 32)}`);
    }
    if (seen.has(id)) throw new ConfigError(`duplicate model id: ${id}`);
    seen.add(id);
  }

  const maxOutputTokens =
    raw.maxOutputTokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : raw.maxOutputTokens;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 65_536) {
    throw new ConfigError("maxOutputTokens must be an integer between 1 and 65536");
  }

  const maxConcurrent =
    raw.maxConcurrent === undefined ? DEFAULT_MAX_CONCURRENT : raw.maxConcurrent;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) {
    throw new ConfigError("maxConcurrent must be an integer between 1 and 16");
  }

  const upstreamTimeoutMs =
    raw.upstreamTimeoutMs === undefined ? DEFAULT_UPSTREAM_TIMEOUT_MS : raw.upstreamTimeoutMs;
  if (
    !Number.isInteger(upstreamTimeoutMs) ||
    upstreamTimeoutMs < 1_000 ||
    upstreamTimeoutMs > 600_000
  ) {
    throw new ConfigError("upstreamTimeoutMs must be an integer between 1000 and 600000");
  }

  const allowRemoteImages = raw.allowRemoteImages === true;
  if (raw.allowRemoteImages !== undefined && typeof raw.allowRemoteImages !== "boolean") {
    throw new ConfigError("allowRemoteImages must be a boolean");
  }

  // Per-model reasoning parameters, merged into every request for that model.
  // This is how a thinking model such as hy4 is told to skip its chain of
  // thought, which clients cannot ask for through an OpenAI-shaped request.
  const extraParams = {};
  if (raw.extraParams !== undefined) {
    if (!isPlainObject(raw.extraParams)) {
      throw new ConfigError("extraParams must be an object keyed by model id");
    }
    for (const [id, entry] of Object.entries(raw.extraParams)) {
      if (!seen.has(id)) {
        throw new ConfigError(`extraParams has a model id that is not in models: ${id}`);
      }
      const label = `extraParams["${id}"]`;
      let params = entry;
      let when;
      if (isPlainObject(entry) && entry.when !== undefined) {
        for (const key of Object.keys(entry)) {
          if (key !== "when" && key !== "params") {
            throw new ConfigError(`${label} takes only "when" and "params"`);
          }
        }
        when = validateWhen(entry.when, label);
        params = entry.params ?? {};
      }
      const result = validateReasoningParams(params, label);
      if (!result.ok) throw new ConfigError(result.message);
      if (when) {
        extraParams[id] = Object.freeze({ when, params: result.value });
      } else if (Object.keys(result.value).length > 0) {
        extraParams[id] = result.value;
      }
    }
  }

  const dir = configPath ? path.dirname(configPath) : defaultConfigDir();
  const apiKeyFile =
    typeof raw.apiKeyFile === "string" && raw.apiKeyFile.trim()
      ? path.resolve(dir, raw.apiKeyFile.trim())
      : path.join(dir, "api-key");

  return Object.freeze({
    envId,
    functionName,
    region,
    port,
    localToken,
    models: Object.freeze([...models]),
    maxOutputTokens,
    maxConcurrent,
    upstreamTimeoutMs,
    allowRemoteImages,
    extraParams: Object.freeze(extraParams),
    apiKeyFile,
    configDir: dir,
  });
}

export async function loadConfig(configPath = defaultConfigPath()) {
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ConfigError(
        `config not found: ${configPath}. Run \`cloudbase-bridge init --env-id <env-id>\` first.`,
      );
    }
    throw error;
  }
  await assertPrivateFile(configPath, "config file");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`config file is not valid JSON: ${configPath}`);
  }
  return { config: validateConfig(raw, { configPath }), configPath };
}

/**
 * The key is read once at startup and kept in memory. CLOUDBASE_API_KEY wins
 * over the file (handy for systemd credentials or a transient shell).
 */
export async function loadApiKey(config, env = process.env) {
  if (typeof env.CLOUDBASE_API_KEY === "string" && env.CLOUDBASE_API_KEY.trim()) {
    return env.CLOUDBASE_API_KEY.trim();
  }
  await assertPrivateFile(config.apiKeyFile, "API key file");
  const key = (await readFile(config.apiKeyFile, "utf8")).trim();
  if (!key) throw new ConfigError(`API key file is empty: ${config.apiKeyFile}`);
  if (/\s/.test(key)) throw new ConfigError("API key must not contain whitespace or newlines");
  return key;
}

export async function initConfig({
  dir = defaultConfigDir(),
  envId,
  functionName = DEFAULT_FUNCTION,
  region = "cn",
  port = DEFAULT_PORT,
  force = false,
} = {}) {
  if (!isValidEnvId(envId ?? "")) {
    throw new ConfigError("--env-id is required and must be 3-64 characters: letters, digits, - or _");
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const configPath = path.join(dir, "config.json");
  const exists = await stat(configPath).then(
    () => true,
    () => false,
  );
  if (exists && !force) {
    throw new ConfigError(`${configPath} already exists (use --force to overwrite)`);
  }

  const localToken = randomBytes(32).toString("base64url");
  const raw = {
    envId,
    functionName,
    region,
    port,
    localToken,
    apiKeyFile: path.join(dir, "api-key"),
    models: Object.keys(MODEL_CATALOG),
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    allowRemoteImages: false,
    extraParams: {},
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    upstreamTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
  };
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  return { configPath, config: validateConfig(raw, { configPath }) };
}

/** Used by /v1/models. */
export function modelInfo(id) {
  const spec = MODEL_CATALOG[id];
  return spec
    ? { id, name: spec.name, context: spec.context, output: spec.output, image: spec.image }
    : { id, name: id, context: 131_072, output: 16_384, image: true };
}
