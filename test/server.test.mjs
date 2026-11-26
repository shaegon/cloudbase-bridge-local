import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.mjs";
import { createBridgeServer } from "../src/server.mjs";

const API_KEY = "SUPER-SECRET-CLOUDBASE-KEY";

const completion = {
  id: "chatcmpl-test",
  created: 1_700_000_000,
  model: "hy3",
  choices: [
    { index: 0, message: { role: "assistant", content: "hello from aiProxy" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
};

function makeConfig(overrides = {}) {
  return validateConfig({
    envId: "cloud1-test",
    localToken: "L".repeat(40),
    models: ["hy3", "hy4"],
    maxConcurrent: 4,
    ...overrides,
  });
}

async function start(t, { config = makeConfig(), invokeImpl, logger } = {}) {
  const logs = [];
  const log = logger ?? ((level, msg, fields = {}) => logs.push({ level, msg, ...fields }));
  const server = createBridgeServer({
    config,
    apiKey: API_KEY,
    logger: log,
    invokeImpl: invokeImpl ?? (async () => completion),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, logs, server, config };
}

function headers(config, extra = {}) {
  return {
    authorization: `Bearer ${config.localToken}`,
    "content-type": "application/json",
    ...extra,
  };
}

const chatBody = JSON.stringify({
  model: "cloudbase/hy3",
  messages: [{ role: "user", content: "hi" }],
});

test("healthz is available without a token", async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "cloudbase-bridge-local");
});

test("/v1/models requires the local token", async (t) => {
  const { base, config } = await start(t);
  const missing = await fetch(`${base}/v1/models`);
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, "invalid_token");

  const wrong = await fetch(`${base}/v1/models`, {
    headers: { authorization: "Bearer wrong-token" },
  });
  assert.equal(wrong.status, 401);

  const ok = await fetch(`${base}/v1/models`, { headers: headers(config) });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(
    body.data.map((model) => model.id),
    ["hy3", "hy4"],
  );
});

test("non-streaming chat returns an OpenAI completion and echoes the requested model", async (t) => {
  const { base, config } = await start(t);
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: headers(config),
    body: chatBody,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "cloudbase/hy3");
  assert.equal(body.choices[0].message.content, "hello from aiProxy");
  assert.equal(body.usage.total_tokens, 8);
});

test("streaming chat synthesizes SSE ending with [DONE]", async (t) => {
  const { base, config } = await start(t);
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ ...JSON.parse(chatBody), stream: true }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await response.text();
  assert.ok(text.includes("hello from aiProxy"));
  assert.ok(text.endsWith("data: [DONE]\n\n"));
});

test("unknown model returns 404 before invoking upstream", async (t) => {
  let invoked = false;
  const { base, config } = await start(t, {
    invokeImpl: async () => {
      invoked = true;
      return completion;
    },
  });
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ model: "hy3-evil", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "model_not_found");
  assert.equal(invoked, false);
});

test("remote images are rejected unless enabled", async (t) => {
  const { base, config } = await start(t);
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      model: "hy3",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }],
        },
      ],
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "remote_image_not_allowed");
});

test("concurrency limit returns 429", async (t) => {
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });

  const { base, config } = await start(t, {
    config: makeConfig({ maxConcurrent: 1 }),
    invokeImpl: async () => {
      signalStarted();
      await gate;
      return completion;
    },
  });

  const first = fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: headers(config),
    body: chatBody,
  });
  await started;

  const second = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: headers(config),
    body: chatBody,
  });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, "concurrency_limit");

  releaseGate();
  const firstResponse = await first;
  assert.equal(firstResponse.status, 200);
  await firstResponse.text();
});

test("logs never contain the CloudBase key or the local token", async (t) => {
  const { base, config, logs } = await start(t);
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: headers(config),
    body: chatBody,
  });
  await response.text();
  const serialized = JSON.stringify(logs);
  assert.ok(serialized.length > 0);
  assert.equal(serialized.includes(API_KEY), false);
  assert.equal(serialized.includes(config.localToken), false);
});

test("unknown routes and wrong methods are rejected", async (t) => {
  const { base, config } = await start(t);
  const notFound = await fetch(`${base}/v1/nope`, { headers: headers(config) });
  assert.equal(notFound.status, 404);

  const wrongMethod = await fetch(`${base}/v1/chat/completions`, {
    method: "GET",
    headers: headers(config),
  });
  assert.equal(wrongMethod.status, 405);
});

test("reasoning parameters reach the function event and are named in the log", async (t) => {
  const seen = [];
  const { base, config, logs } = await start(t, {
    invokeImpl: async (event) => {
      seen.push(event);
      return completion;
    },
  });
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      model: "hy4",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    }),
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.deepEqual(seen[0].extra, { thinking: { type: "disabled" } });
  const started = logs.find((entry) => entry.msg === "chat_start");
  assert.equal(started.extra, "thinking");
});

test("a request with no reasoning fields carries none", async (t) => {
  const seen = [];
  const { base, config, logs } = await start(t, {
    invokeImpl: async (event) => {
      seen.push(event);
      return completion;
    },
  });
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: headers(config),
    body: chatBody,
  });
  await response.text();
  assert.equal("extra" in seen[0], false);
  const started = logs.find((entry) => entry.msg === "chat_start");
  assert.equal("extra" in started, false);
});

test("a guarded model sends no thinking for a small budget, and the guard is logged", async (t) => {
  const seen = [];
  const config = makeConfig({
    extraParams: { hy4: { when: { maxTokensAtMost: 4096 }, params: { thinking: { type: "disabled" } } } },
  });
  const { base, logs } = await start(t, {
    config,
    invokeImpl: async (event) => {
      seen.push(event);
      return completion;
    },
  });
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      model: "hy4",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 2112,
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(seen[0].extra, { thinking: { type: "disabled" } });
  const guard = logs.find((entry) => entry.msg === "reasoning_guard_applied");
  assert.equal(guard.limit, 4096);
  assert.equal(guard.model, "hy4");
});

test("an unsupported effort level is dropped and logged, and the request still succeeds", async (t) => {
  const seen = [];
  const { base, config, logs } = await start(t, {
    invokeImpl: async (event) => {
      seen.push(event);
      return completion;
    },
  });
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      model: "hy4",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "turbo",
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal("extra" in seen[0], false);
  const dropped = logs.find((entry) => entry.msg === "extra_param_dropped");
  assert.equal(dropped.dropped, "reasoning_effort");
});
