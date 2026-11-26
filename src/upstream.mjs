/**
 * CloudBase function-invocation client.
 *
 * The URL is derived only from the validated envId/functionName in the config,
 * and the API key is attached only to this request. There is no base-URL
 * override by design.
 */

import { MAX_EVENT_BYTES } from "./config.mjs";
import { UpstreamError } from "./errors.mjs";

const GATEWAY_SUFFIX_CN = ".api.tcloudbasegateway.com";
const GATEWAY_SUFFIX_INTL = ".api.intl.tcloudbasegateway.com";
const USER_AGENT = "cloudbase-bridge-local/0.1.0";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function gatewayBase(config) {
  const host =
    config.region === "intl"
      ? `${config.envId}${GATEWAY_SUFFIX_INTL}`
      : `${config.envId}${GATEWAY_SUFFIX_CN}`;
  return `https://${host}`;
}

export function invokeUrl(config) {
  return `${gatewayBase(config)}/v1/functions/${encodeURIComponent(config.functionName)}`;
}

export function mapGatewayStatus(status, code) {
  switch (code) {
    case "PERMISSION_DENIED":
    case "ACTION_FORBIDDEN":
    case "INVALID_TOKEN":
    case "TOKEN_EXPIRED":
      return 401;
    case "EXCEED_AUTHORITY":
    case "AI_CHANNEL_NOT_ALLOWED":
      return 403;
    case "FUNCTIONS_NOT_FOUND":
    case "FUNCTIONS_QUALIFIER_NOT_FOUND":
    case "AI_MODEL_NOT_SUPPORTED":
    case "AI_MODEL_DISABLED":
    case "AI_MODEL_NOT_FOUND":
      return 404;
    case "EXCEED_TOKEN_QUOTA_LIMIT":
    case "EXCEED_QUOTA":
    case "EXCEED_CONCURRENT_REQUEST_LIMIT":
    case "FUNCTIONS_EXCEED_RESOURCE_LIMIT":
    case "EXCEED_RATE_LIMIT":
      return 429;
    case "FUNCTIONS_TIME_LIMIT_EXCEEDED":
      return 504;
    case "FUNCTIONS_INVOCATION_FAILED":
    case "FUNCTIONS_MEMORY_LIMIT_EXCEEDED":
    case "FUNCTIONS_STATUS_ABNORMAL":
      return 502;
    default:
      return status >= 500 ? 502 : status;
  }
}

export function statusForFunctionError(code) {
  switch (code) {
    case "INVALID_REQUEST":
    case "IMAGE_INPUT_NOT_SUPPORTED":
    case "AI_MODEL_PARAM_INVALID":
    case "REMOTE_IMAGE_NOT_ALLOWED":
      return 400;
    case "AI_CHANNEL_NOT_ALLOWED":
      return 403;
    case "MODEL_NOT_ALLOWED":
    case "AI_MODEL_NOT_SUPPORTED":
    case "AI_MODEL_DISABLED":
    case "AI_MODEL_NOT_FOUND":
      return 404;
    case "EXCEED_TOKEN_QUOTA_LIMIT":
    case "EXCEED_QUOTA":
    case "EXCEED_CONCURRENT_REQUEST_LIMIT":
      return 429;
    default:
      // The function reports a model API's own HTTP failure as the bare
      // numeric code (e.g. "429" when CloudBase rate-limits the model call).
      // Passing 429 through matters: as a 502 the client retries at once and
      // makes the rate limiting worse.
      return /^429$/.test(code) ? 429 : 502;
  }
}

/** A bare numeric upstream code is not a useful name for the client. */
function clientErrorCode(code, status) {
  if (status === 429 && /^\d{3}$/.test(code)) return "upstream_rate_limited";
  return code;
}

async function readLimited(response, limit) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new UpstreamError(
          502,
          "upstream_response_too_large",
          `aiProxy response exceeded ${limit} bytes.`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function combineSignals(signal, timeoutSignal) {
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeoutSignal]);
  const controller = new AbortController();
  const forward = (source) => () => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", forward(signal), { once: true });
  if (!controller.signal.aborted) {
    if (timeoutSignal.aborted) controller.abort(timeoutSignal.reason);
    else timeoutSignal.addEventListener("abort", forward(timeoutSignal), { once: true });
  }
  return controller.signal;
}

/**
 * Invoke aiProxy with the given event.
 * @param {object} event
 * @param {{config: object, apiKey: string, signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number}} options
 */
export async function invokeFunction(
  event,
  { config, apiKey, signal, fetchImpl = fetch, timeoutMs = config.upstreamTimeoutMs },
) {
  const payload = JSON.stringify(event);
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > MAX_EVENT_BYTES) {
    throw new UpstreamError(
      413,
      "payload_too_large",
      `Request payload is ${bytes} bytes; CloudBase accepts at most ${MAX_EVENT_BYTES}.`,
    );
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? combineSignals(signal, timeoutSignal) : timeoutSignal;

  let response;
  try {
    response = await fetchImpl(invokeUrl(config), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": USER_AGENT,
        authorization: `Bearer ${apiKey}`,
      },
      body: payload,
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeoutSignal.aborted) {
      throw new UpstreamError(
        504,
        "invoke_timeout",
        `CloudBase function invocation timed out after ${Math.round(timeoutMs / 1000)} s.`,
      );
    }
    const reason = error instanceof Error ? truncate(error.message, 160) : "unknown network error";
    throw new UpstreamError(502, "network_error", `Could not reach the CloudBase gateway: ${reason}`);
  }

  let text;
  try {
    text = await readLimited(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new UpstreamError(
        504,
        "invoke_timeout",
        `CloudBase function invocation timed out after ${Math.round(timeoutMs / 1000)} s.`,
      );
    }
    throw error;
  }

  if (!response.ok) {
    const body = parseJson(text);
    const code =
      body && typeof body === "object" && typeof body.code === "string"
        ? body.code
        : `HTTP_${response.status}`;
    const message =
      body && typeof body === "object" && typeof body.message === "string"
        ? truncate(body.message, 300)
        : "(no message)";
    const requestId =
      body && typeof body === "object" && typeof body.requestId === "string"
        ? body.requestId
        : undefined;
    throw new UpstreamError(mapGatewayStatus(response.status, code), code, message, requestId);
  }

  const parsed = parseJson(text);
  if (parsed === undefined) {
    throw new UpstreamError(
      502,
      "invalid_function_json",
      "aiProxy returned a non-JSON body. Redeploy the function from cloudfunctions/aiProxy.",
    );
  }

  if (parsed && typeof parsed === "object" && parsed.error && typeof parsed.error === "object") {
    const code = typeof parsed.error.code === "string" ? parsed.error.code : "UPSTREAM_ERROR";
    const message =
      typeof parsed.error.message === "string"
        ? truncate(parsed.error.message, 400)
        : "aiProxy returned an error without a message.";
    const requestId =
      typeof parsed.error.requestId === "string" ? parsed.error.requestId : undefined;
    const status = statusForFunctionError(code);
    throw new UpstreamError(status, clientErrorCode(code, status), message, requestId);
  }

  return parsed;
}
