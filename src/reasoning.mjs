/**
 * The reasoning-related request fields this bridge is willing to forward.
 *
 * Everything the gateway does not understand is dropped on purpose. That is
 * what kept the host's reasoning settings from ever reaching CloudBase: a
 * thinking model such as `hy4` always answered with its chain of thought, so a
 * request with a small `max_tokens` (a client's background classifier, for
 * instance) came back with no visible text at all.
 *
 * These four names are forwarded — and only after shape validation, so a
 * request can never smuggle arbitrary parameters into the CloudBase call.
 */

export const REASONING_PARAM_KEYS = Object.freeze([
  "reasoning_effort",
  "thinking",
  "enable_thinking",
  "chat_template_kwargs",
]);

/**
 * Hosts label their effort levels themselves (Magpie offers none, min, minimal,
 * low, medium, high, xhigh, max, priority, fast). Map the clear synonyms onto
 * the levels CloudBase accepts; anything else is dropped rather than failing
 * the request, because an unsupported hint must never break a working session.
 */
const REASONING_EFFORT_ALIASES = new Map([
  ["none", "none"],
  ["min", "minimal"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "high"],
  ["max", "high"],
  ["priority", "high"],
]);
const THINKING_TYPES = new Set(["enabled", "disabled"]);
const MIN_BUDGET_TOKENS = 1024;
const MAX_BUDGET_TOKENS = 100_000;
const MAX_EXTRA_CHARS = 512;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the reasoning parameters of a request (or of one `extraParams`
 * entry). Returns { ok: true, value, dropped } or { ok: false, message };
 * `message` never quotes request content, only key names.
 */
export function validateReasoningParams(raw, label = "reasoning parameters") {
  const fail = (message) => ({ ok: false, message });
  if (!isPlainObject(raw)) return fail(`${label} must be a JSON object.`);
  const keys = Object.keys(raw);
  const unknown = keys.filter((key) => !REASONING_PARAM_KEYS.includes(key));
  if (unknown.length > 0) {
    return fail(`${label} accepts only ${REASONING_PARAM_KEYS.join(", ")} (got ${unknown.join(", ")}).`);
  }

  const value = {};
  const dropped = [];
  for (const key of keys) {
    const input = raw[key];
    if (key === "reasoning_effort") {
      const effort = typeof input === "string" ? input.trim().toLowerCase() : "";
      const mapped = REASONING_EFFORT_ALIASES.get(effort);
      if (!mapped) {
        dropped.push(key);
        continue;
      }
      value.reasoning_effort = mapped;
    } else if (key === "thinking") {
      if (!isPlainObject(input)) return fail(`${label}.thinking must be a JSON object.`);
      if (Object.keys(input).some((k) => k !== "type" && k !== "budget_tokens")) {
        return fail(`${label}.thinking accepts only type and budget_tokens.`);
      }
      const type = typeof input.type === "string" ? input.type.trim().toLowerCase() : "";
      if (!THINKING_TYPES.has(type)) {
        return fail(`${label}.thinking.type must be "enabled" or "disabled".`);
      }
      const thinking = { type };
      if (input.budget_tokens !== undefined && input.budget_tokens !== null) {
        if (
          !Number.isInteger(input.budget_tokens) ||
          input.budget_tokens < MIN_BUDGET_TOKENS ||
          input.budget_tokens > MAX_BUDGET_TOKENS
        ) {
          return fail(
            `${label}.thinking.budget_tokens must be an integer between ${MIN_BUDGET_TOKENS} and ${MAX_BUDGET_TOKENS}.`,
          );
        }
        thinking.budget_tokens = input.budget_tokens;
      }
      value.thinking = thinking;
    } else if (key === "enable_thinking") {
      if (typeof input !== "boolean") return fail(`${label}.enable_thinking must be a boolean.`);
      value.enable_thinking = input;
    } else {
      if (!isPlainObject(input)) return fail(`${label}.chat_template_kwargs must be a JSON object.`);
      if (Object.keys(input).some((k) => k !== "enable_thinking")) {
        return fail(`${label}.chat_template_kwargs accepts only enable_thinking.`);
      }
      if (typeof input.enable_thinking !== "boolean") {
        return fail(`${label}.chat_template_kwargs.enable_thinking must be a boolean.`);
      }
      value.chat_template_kwargs = { enable_thinking: input.enable_thinking };
    }
  }

  if (JSON.stringify(value).length > MAX_EXTRA_CHARS) {
    return fail(`${label} is too large (limit ${MAX_EXTRA_CHARS} bytes).`);
  }
  return { ok: true, value: Object.freeze(value), dropped };
}
