/**
 * Loopback-only OpenAI-compatible HTTP server.
 *
 * Security properties:
 * - binds 127.0.0.1 only;
 * - every /v1 request needs the local random token (constant-time compare);
 * - request bodies are capped before parsing;
 * - the CloudBase key is never logged, never echoed, and only used by upstream.mjs;
 * - a small concurrency cap limits accidental quota burn.
 */

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { SERVICE, VERSION, modelInfo } from "./config.mjs";
import { RequestError, UpstreamError } from "./errors.mjs";
import {
  parseChatRequest,
  normalizeCompletion,
  toChatCompletion,
  sseFrames,
  errorPayload,
} from "./openai.mjs";
import { invokeFunction } from "./upstream.mjs";

export const MAX_BODY_BYTES = 7 * 1024 * 1024;

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
  }

  tryAcquire() {
    if (this.active >= this.limit) return false;
    this.active += 1;
    return true;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
  }
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function tokenMatches(expected, presented) {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(presented).digest();
  return timingSafeEqual(left, right);
}

function isAuthorized(req, expectedToken) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? tokenMatches(expectedToken, match[1].trim()) : false;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      fail(
        new RequestError(
          413,
          "payload_too_large",
          `Request body is ${declared} bytes; the limit is ${limit}.`,
        ),
      );
      req.pause();
      return;
    }

    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(
          new RequestError(
            413,
            "payload_too_large",
            `Request body exceeded the ${limit}-byte limit.`,
          ),
        );
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => fail(error));
    req.on("aborted", () => fail(new RequestError(400, "client_aborted", "Client aborted.")));
  });
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function waitForDrainOrClose(res) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

function modelsPayload(config) {
  return {
    object: "list",
    data: config.models.map((id) => {
      const info = modelInfo(id);
      return {
        id,
        object: "model",
        created: 0,
        owned_by: "cloudbase",
        name: info.name,
        context_length: info.context,
        max_output_tokens: info.output,
        modalities: {
          input: info.image ? ["text", "image"] : ["text"],
          output: ["text"],
        },
      };
    }),
  };
}

/**
 * @param {{config: object, apiKey: string, logger?: Function, fetchImpl?: typeof fetch, invokeImpl?: Function}} options
 */
export function createBridgeServer({
  config,
  apiKey,
  logger = () => {},
  fetchImpl = fetch,
  invokeImpl = (event, { signal }) =>
    invokeFunction(event, {
      config,
      apiKey,
      signal,
      fetchImpl,
      timeoutMs: config.upstreamTimeoutMs,
    }),
}) {
  const semaphore = new Semaphore(config.maxConcurrent);

  async function handleChat(req, res) {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    const rawBody = await readBody(req, MAX_BODY_BYTES);
    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new RequestError(400, "invalid_request", "Request body is not valid JSON.");
    }

    const request = parseChatRequest(parsed, config);
    if (request.clampedMaxTokens) {
      logger("warn", "max_tokens_clamped", {
        requested: request.clampedMaxTokens.requested,
        used: request.clampedMaxTokens.used,
      });
    }
    if (request.reasoningGuard) {
      logger("info", "reasoning_guard_applied", {
        model: request.model,
        limit: request.reasoningGuard,
        reason: "the output budget is too small to hold thinking and an answer",
      });
    }
    if (request.droppedExtraKeys && request.droppedExtraKeys.length > 0) {
      logger("warn", "extra_param_dropped", {
        dropped: request.droppedExtraKeys.join(","),
        reason: "value not supported by the CloudBase models",
      });
    }

    if (!semaphore.tryAcquire()) {
      throw new RequestError(
        429,
        "concurrency_limit",
        `Too many concurrent requests (limit ${config.maxConcurrent}). Retry shortly.`,
      );
    }

    const startedAt = Date.now();
    try {
      logger("info", "chat_start", {
        model: request.model,
        stream: request.stream,
        messages: request.event.messages.length,
        bytes: rawBody.length,
        ...(request.extraKeys && request.extraKeys.length > 0
          ? { extra: request.extraKeys.join(",") }
          : {}),
      });

      let raw;
      try {
        raw = await invokeImpl(request.event, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) {
          logger("info", "client_aborted", { model: request.model });
          if (!res.writableEnded && !res.destroyed) res.end();
          return;
        }
        throw error;
      }
      const completion = normalizeCompletion(raw);

      if (controller.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }

      logger("info", "chat_ok", {
        model: request.model,
        stream: request.stream,
        ms: Date.now() - startedAt,
        tokens: completion.usage?.total_tokens ?? null,
        ...(completion.upstreamModel ? { upstream: completion.upstreamModel } : {}),
      });

      if (request.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        for (const frame of sseFrames(completion, request.requestedModel)) {
          if (res.destroyed) break;
          if (!res.write(frame)) await waitForDrainOrClose(res);
        }
        if (!res.writableEnded) res.end();
        return;
      }

      sendJson(res, 200, toChatCompletion(completion, request.requestedModel));
    } finally {
      semaphore.release();
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname === "/healthz" && req.method === "GET") {
      sendJson(res, 200, { ok: true, service: SERVICE, version: VERSION });
      return;
    }

    const isModels = pathname === "/v1/models" || pathname === "/models";
    const isChat = pathname === "/v1/chat/completions" || pathname === "/chat/completions";
    if (!isModels && !isChat) {
      sendJson(res, 404, errorPayload(404, "not_found", `No route for ${req.method} ${pathname}.`));
      return;
    }

    if (!isAuthorized(req, config.localToken)) {
      logger("warn", "auth_rejected", { route: pathname });
      sendJson(res, 401, errorPayload(401, "invalid_token", "Invalid local bearer token."));
      return;
    }

    if (isModels) {
      if (req.method !== "GET") {
        sendJson(res, 405, errorPayload(405, "method_not_allowed", "Use GET."));
        return;
      }
      sendJson(res, 200, modelsPayload(config));
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, errorPayload(405, "method_not_allowed", "Use POST."));
      return;
    }

    try {
      await handleChat(req, res);
    } catch (error) {
      if (error instanceof RequestError) {
        logger("warn", "request_error", { code: error.code, status: error.status });
        if (!res.headersSent) {
          sendJson(res, error.status, errorPayload(error.status, error.code, error.message));
        } else if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      if (error instanceof UpstreamError) {
        logger("warn", "upstream_error", {
          code: error.code,
          status: error.status,
          requestId: error.requestId ?? null,
        });
        if (!res.headersSent) {
          sendJson(
            res,
            error.status,
            errorPayload(error.status, error.code, error.message, error.requestId),
          );
        } else if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      logger("error", "unhandled_error", {
        message: truncate(error instanceof Error ? error.message : String(error), 200),
      });
      if (!res.headersSent) {
        sendJson(
          res,
          502,
          errorPayload(502, "internal_error", "The bridge failed to process this request."),
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger("error", "handler_crash", {
        message: truncate(error instanceof Error ? error.message : String(error), 200),
      });
      if (!res.headersSent) {
        sendJson(res, 500, errorPayload(500, "internal_error", "Internal bridge error."));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
  server.keepAliveTimeout = 65_000;
  return server;
}
