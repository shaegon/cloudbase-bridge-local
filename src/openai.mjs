/**
 * OpenAI Chat Completions <-> aiProxy adapters.
 *
 * The gateway only ever forwards fields it understands; everything else in the
 * request body is dropped. This keeps the upstream event small and predictable.
 * The one deliberate exception is the reasoning allowlist in reasoning.mjs:
 * without it a thinking model never hears that it was asked not to think.
 */

import { randomUUID } from "node:crypto";
import { RequestError, UpstreamError } from "./errors.mjs";
import { REASONING_PARAM_KEYS, validateReasoningParams } from "./reasoning.mjs";

const MODEL_PREFIXES = ["cloudbase/", "cloudbase-plugin/", "cloudbase-local/"];
const MAX_MESSAGES = 10_000;
const MAX_TOOLS = 128;
const SSE_CHUNK_CHARS = 200;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function stripModelPrefix(raw) {
  if (typeof raw !== "string") return "";
  let model = raw.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of MODEL_PREFIXES) {
      if (model.startsWith(prefix)) {
        model = model.slice(prefix.length);
        changed = true;
      }
    }
  }
  return model;
}

function assertImagePolicy(messages, allowRemoteImages) {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!isPlainObject(message) || !Array.isArray(message.content)) continue;
    for (let j = 0; j < message.content.length; j += 1) {
      const part = message.content[j];
      if (!isPlainObject(part) || part.type !== "image_url") continue;
      const url =
        isPlainObject(part.image_url) && typeof part.image_url.url === "string"
          ? part.image_url.url.trim()
          : "";
      if (/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(url)) continue;
      if (/^https?:\/\/\S+$/i.test(url)) {
        if (!allowRemoteImages) {
          throw new RequestError(
            400,
            "remote_image_not_allowed",
            `messages[${i}].content[${j}] is a remote image URL. This bridge disables remote image fetching by default because the model provider would fetch an arbitrary URL. Use a data:image/...;base64 URL, or set allowRemoteImages=true deliberately.`,
          );
        }
        continue;
      }
      throw new RequestError(
        400,
        "invalid_image_url",
        `messages[${i}].content[${j}].image_url.url must be a data:image/...;base64 URL${allowRemoteImages ? " or an http(s) URL" : ""}.`,
      );
    }
  }
}

/**
 * Gather the reasoning parameters a client sent: the allowlisted names at the
 * top level (that is how OpenAI-compatible clients send them), plus anything
 * inside `extra` (for hosts that keep unknown fields out of the way).
 * Unknown names are rejected later, by validateReasoningParams.
 */
function collectReasoningParams(body) {
  const collected = {};
  for (const key of REASONING_PARAM_KEYS) {
    if (body[key] !== undefined && body[key] !== null) collected[key] = body[key];
  }
  if (body.extra !== undefined && body.extra !== null) {
    if (!isPlainObject(body.extra)) {
      throw new RequestError(400, "invalid_reasoning_params", "`extra` must be a JSON object.");
    }
    Object.assign(collected, body.extra);
  }
  return collected;
}

/**
 * A per-model config entry is either the parameters themselves or the guarded
 * form `{ when: { maxTokensAtMost }, params }`, which only applies to a request
 * whose output budget is that small — the budget that a thinking model would
 * otherwise spend entirely on its chain of thought.
 * Returns { params, guard } where guard is the limit that matched, if any.
 */
function resolveConfigExtra(entry, maxTokens) {
  if (!entry) return { params: null, guard: null };
  if (entry.when === undefined) return { params: entry, guard: null };
  if (!Number.isInteger(maxTokens)) return { params: null, guard: null };
  if (maxTokens > entry.when.maxTokensAtMost) return { params: null, guard: null };
  return { params: entry.params, guard: entry.when.maxTokensAtMost };
}

/**
 * Validate a Chat Completions request and build the aiProxy event.
 * Returns { event, stream, requestedModel, model, clampedMaxTokens, extraKeys,
 * droppedExtraKeys, reasoningGuard }.
 */
export function parseChatRequest(body, config) {
  if (!isPlainObject(body)) {
    throw new RequestError(400, "invalid_request", "Request body must be a JSON object.");
  }
  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
  let model = stripModelPrefix(requestedModel);
  if (!model) {
    throw new RequestError(400, "invalid_request", "`model` is required.");
  }
  // Hosts (Magpie/OpenCode) prefix model ids with the provider name, which is
  // user-chosen. Accept "<anything>/<allowed-model>" only when the tail is in
  // the allowlist.
  if (!config.models.includes(model)) {
    const slash = requestedModel.indexOf("/");
    if (slash > 0) {
      const tail = requestedModel.slice(slash + 1);
      if (config.models.includes(tail)) model = tail;
    }
  }
  if (!config.models.includes(model)) {
    throw new RequestError(
      404,
      "model_not_found",
      `Model "${truncate(model, 64)}" is not in this bridge's allowlist (${config.models.join(", ")}).`,
    );
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new RequestError(400, "invalid_request", "`messages` must be a non-empty array.");
  }
  if (body.messages.length > MAX_MESSAGES) {
    throw new RequestError(
      400,
      "invalid_request",
      `Too many messages (${body.messages.length}; limit ${MAX_MESSAGES}).`,
    );
  }
  assertImagePolicy(body.messages, config.allowRemoteImages);

  const event = { action: "chat", model, messages: body.messages };

  if (body.temperature !== undefined && body.temperature !== null) {
    if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature)) {
      throw new RequestError(400, "invalid_request", "`temperature` must be a number.");
    }
    if (body.temperature < 0 || body.temperature > 2) {
      throw new RequestError(400, "invalid_request", "`temperature` must be between 0 and 2.");
    }
    event.temperature = body.temperature;
  }

  if (body.top_p !== undefined && body.top_p !== null) {
    if (typeof body.top_p !== "number" || !Number.isFinite(body.top_p)) {
      throw new RequestError(400, "invalid_request", "`top_p` must be a number.");
    }
    if (body.top_p < 0 || body.top_p > 1) {
      throw new RequestError(400, "invalid_request", "`top_p` must be between 0 and 1.");
    }
    event.topP = body.top_p;
  }

  let clampedMaxTokens;
  const requestedMax = body.max_completion_tokens ?? body.max_tokens;
  if (requestedMax !== undefined && requestedMax !== null) {
    if (!Number.isInteger(requestedMax) || requestedMax < 1) {
      throw new RequestError(400, "invalid_request", "`max_tokens` must be a positive integer.");
    }
    const used = Math.min(requestedMax, config.maxOutputTokens);
    event.maxTokens = used;
    if (used !== requestedMax) {
      clampedMaxTokens = { requested: requestedMax, used };
    }
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    if (body.tools.length > MAX_TOOLS) {
      throw new RequestError(400, "invalid_request", `Too many tools (limit ${MAX_TOOLS}).`);
    }
    event.tools = body.tools;
    if (body.tool_choice !== undefined && body.tool_choice !== null) {
      event.toolChoice = body.tool_choice;
    }
  }

  // Per-model config first, then whatever this request asked for.
  const clientExtra = collectReasoningParams(body);
  const configured = resolveConfigExtra(
    (config.extraParams && config.extraParams[model]) || null,
    event.maxTokens,
  );
  const mergedExtra = { ...(configured.params ?? {}), ...clientExtra };
  let extraKeys = [];
  let droppedExtraKeys = [];
  if (Object.keys(mergedExtra).length > 0) {
    const result = validateReasoningParams(mergedExtra, "reasoning parameters");
    if (!result.ok) {
      throw new RequestError(400, "invalid_reasoning_params", result.message);
    }
    if (Object.keys(result.value).length > 0) {
      event.extra = result.value;
      extraKeys = Object.keys(result.value);
    }
    droppedExtraKeys = result.dropped;
  }

  return {
    event,
    stream: body.stream === true,
    requestedModel: requestedModel || model,
    model,
    clampedMaxTokens,
    extraKeys,
    droppedExtraKeys,
    reasoningGuard: configured.guard,
  };
}

function normalizeUsage(usage) {
  const toInt = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  if (!isPlainObject(usage)) return null;
  const prompt = toInt(usage.prompt_tokens);
  const completion = toInt(usage.completion_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: toInt(usage.total_tokens) || prompt + completion,
  };
}

/** Validate the aiProxy completion; throws UpstreamError when unusable. */
export function normalizeCompletion(value) {
  if (!isPlainObject(value)) {
    throw new UpstreamError(502, "invalid_function_response", "aiProxy reply is not a JSON object.");
  }
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const first = choices[0];
  if (!isPlainObject(first) || !isPlainObject(first.message)) {
    throw new UpstreamError(
      502,
      "invalid_function_response",
      "aiProxy reply is missing `choices[0].message`.",
    );
  }
  const message = first.message;

  const content =
    typeof message.content === "string" ? message.content : message.content === null ? "" : "";
  const reasoningContent =
    typeof message.reasoning_content === "string" ? message.reasoning_content : "";

  const toolCalls = [];
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fn = isPlainObject(call) && isPlainObject(call.function) ? call.function : null;
      if (!fn || typeof fn.name !== "string" || fn.name.length === 0) continue;
      toolCalls.push({
        id:
          typeof call.id === "string" && call.id.length > 0
            ? call.id
            : `call_${randomUUID().slice(0, 12)}`,
        type: "function",
        function: {
          name: fn.name,
          arguments:
            typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        },
      });
    }
  }

  const rawFinish = typeof first.finish_reason === "string" ? first.finish_reason : "";
  const finishReason =
    rawFinish === "length" ? "length" : toolCalls.length > 0 ? "tool_calls" : rawFinish || "stop";

  return {
    id: typeof value.id === "string" ? value.id : `chatcmpl-${randomUUID().slice(0, 12)}`,
    created:
      typeof value.created === "number" && Number.isFinite(value.created)
        ? Math.floor(value.created)
        : Math.floor(Date.now() / 1000),
    upstreamModel: typeof value.model === "string" ? value.model : "",
    content,
    reasoningContent,
    toolCalls,
    finishReason,
    usage: normalizeUsage(value.usage),
  };
}

export function toChatCompletion(completion, echoModel) {
  const message =
    completion.toolCalls.length > 0
      ? { role: "assistant", content: completion.content || null, tool_calls: completion.toolCalls }
      : { role: "assistant", content: completion.content };
  if (completion.reasoningContent) message.reasoning_content = completion.reasoningContent;

  const payload = {
    id: completion.id,
    object: "chat.completion",
    created: completion.created,
    model: echoModel,
    choices: [{ index: 0, message, finish_reason: completion.finishReason }],
  };
  if (completion.usage) payload.usage = completion.usage;
  return payload;
}

function chunkText(text, size) {
  const pieces = [];
  let buffer = "";
  for (const character of text) {
    buffer += character;
    if (buffer.length >= size) {
      pieces.push(buffer);
      buffer = "";
    }
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}

/** Yields OpenAI SSE frames for a one-shot completion, ending with [DONE]. */
export function* sseFrames(completion, echoModel) {
  const base = { id: completion.id, created: completion.created, model: echoModel };
  const frame = (delta, finishReason, usage) => {
    const payload = {
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) payload.usage = usage;
    return `data: ${JSON.stringify(payload)}\n\n`;
  };

  yield frame({ role: "assistant", content: "" }, null);
  for (const piece of chunkText(completion.reasoningContent, SSE_CHUNK_CHARS)) {
    yield frame({ reasoning_content: piece }, null);
  }
  for (const piece of chunkText(completion.content, SSE_CHUNK_CHARS)) {
    yield frame({ content: piece }, null);
  }
  for (let index = 0; index < completion.toolCalls.length; index += 1) {
    yield frame({ tool_calls: [{ index, ...completion.toolCalls[index] }] }, null);
  }
  yield frame({}, completion.finishReason || "stop", completion.usage ?? undefined);
  yield "data: [DONE]\n\n";
}

export function errorPayload(status, code, message, requestId) {
  const type =
    status === 400
      ? "invalid_request_error"
      : status === 401
        ? "authentication_error"
        : status === 403
          ? "permission_error"
          : status === 404
            ? "not_found_error"
            : status === 413
              ? "request_too_large"
              : status === 429
                ? "rate_limit_error"
                : status === 504
                  ? "timeout_error"
                  : "api_error";
  const error = { message, type, code };
  if (requestId) error.requestId = requestId;
  return { error };
}
