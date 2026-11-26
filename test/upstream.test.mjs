import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.mjs";
import { invokeFunction, invokeUrl, statusForFunctionError } from "../src/upstream.mjs";
import { UpstreamError } from "../src/errors.mjs";

const config = validateConfig({
  envId: "cloud1-test",
  localToken: "t".repeat(40),
  models: ["hy3"],
});
const API_KEY = "SUPER-SECRET-CLOUDBASE-KEY";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("invokeFunction builds the fixed URL and sends the key only there", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  };
  const result = await invokeFunction(
    { action: "chat", model: "hy3", messages: [] },
    { config, apiKey: API_KEY, fetchImpl },
  );
  assert.equal(
    seen.url,
    "https://cloud1-test.api.tcloudbasegateway.com/v1/functions/aiProxy",
  );
  assert.equal(seen.init.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(seen.init.method, "POST");
  assert.equal(JSON.parse(seen.init.body).action, "chat");
  assert.deepEqual(result.choices[0].message, { content: "ok" });
});

test("invokeUrl uses the intl gateway when configured", () => {
  const intl = validateConfig({
    envId: "cloud1-test",
    localToken: "t".repeat(40),
    region: "intl",
    functionName: "myFn",
    models: ["hy3"],
  });
  assert.equal(
    invokeUrl(intl),
    "https://cloud1-test.api.intl.tcloudbasegateway.com/v1/functions/myFn",
  );
});

test("gateway 401 maps to a 401 UpstreamError without the key", async () => {
  const fetchImpl = async () =>
    jsonResponse({ code: "PERMISSION_DENIED", message: "bad token" }, 401);
  await assert.rejects(
    invokeFunction({ action: "ping" }, { config, apiKey: API_KEY, fetchImpl }),
    (error) =>
      error instanceof UpstreamError &&
      error.status === 401 &&
      error.code === "PERMISSION_DENIED" &&
      !error.message.includes(API_KEY),
  );
});

test("function error envelopes map by code", async () => {
  const fetchImpl = async () =>
    jsonResponse({ error: { code: "MODEL_NOT_ALLOWED", message: "nope", requestId: "r1" } });
  await assert.rejects(
    invokeFunction({ action: "chat" }, { config, apiKey: API_KEY, fetchImpl }),
    (error) =>
      error instanceof UpstreamError &&
      error.status === 404 &&
      error.code === "MODEL_NOT_ALLOWED" &&
      error.requestId === "r1",
  );
});

test("a model API's own 429 comes back as a 429, not a 502", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      error: { code: "429", message: "The model call failed (429).", requestId: "r2" },
    });
  await assert.rejects(
    invokeFunction({ action: "chat" }, { config, apiKey: API_KEY, fetchImpl }),
    (error) =>
      error instanceof UpstreamError &&
      error.status === 429 &&
      error.code === "upstream_rate_limited" &&
      error.requestId === "r2",
  );
});

test("network failures map to 502 and do not include the key", async () => {
  const fetchImpl = async () => {
    throw new Error("connection refused");
  };
  await assert.rejects(
    invokeFunction({ action: "ping" }, { config, apiKey: API_KEY, fetchImpl }),
    (error) =>
      error.status === 502 &&
      error.code === "network_error" &&
      !error.message.includes(API_KEY),
  );
});

test("events above the CloudBase 6 MB cap are rejected before fetch", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return jsonResponse({});
  };
  const huge = { action: "chat", messages: [{ role: "user", content: "a".repeat(6 * 1024 * 1024) }] };
  await assert.rejects(
    invokeFunction(huge, { config, apiKey: API_KEY, fetchImpl }),
    (error) => error.status === 413 && error.code === "payload_too_large",
  );
  assert.equal(called, false);
});

test("upstream timeout maps to 504", async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      // AbortSignal.timeout()'s own timer is unref'd; keep the loop alive so
      // the test runner does not cancel the pending test.
      const keepAlive = setTimeout(() => {}, 5_000);
      init.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(keepAlive);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  await assert.rejects(
    invokeFunction(
      { action: "ping" },
      { config, apiKey: API_KEY, fetchImpl, timeoutMs: 1_000 },
    ),
    (error) => error.status === 504 && error.code === "invoke_timeout",
  );
});

test("statusForFunctionError maps known codes", () => {
  assert.equal(statusForFunctionError("INVALID_REQUEST"), 400);
  assert.equal(statusForFunctionError("REMOTE_IMAGE_NOT_ALLOWED"), 400);
  assert.equal(statusForFunctionError("AI_CHANNEL_NOT_ALLOWED"), 403);
  assert.equal(statusForFunctionError("AI_MODEL_NOT_SUPPORTED"), 404);
  assert.equal(statusForFunctionError("EXCEED_TOKEN_QUOTA_LIMIT"), 429);
  assert.equal(statusForFunctionError("429"), 429);
  assert.equal(statusForFunctionError("500"), 502);
  assert.equal(statusForFunctionError("TCB_ENV_MISSING"), 502);
  assert.equal(statusForFunctionError("SOMETHING_NEW"), 502);
});
