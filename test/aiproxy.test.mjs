import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fn = require("../cloudfunctions/aiProxy/index.js");
const { validateChatEvent, pingResult, failureEnvelope, MAX_OUTPUT_TOKENS } = fn._internal;

function chatEvent(overrides = {}) {
  return {
    action: "chat",
    model: "hy4",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

test("ping does not expose the environment id", (t) => {
  const previous = process.env.TCB_ENV;
  process.env.TCB_ENV = "cloud1-must-not-leak";
  t.after(() => {
    if (previous === undefined) delete process.env.TCB_ENV;
    else process.env.TCB_ENV = previous;
  });
  const ping = pingResult();
  assert.equal("env" in ping, false);
  assert.equal(JSON.stringify(ping).includes("cloud1-must-not-leak"), false);
});

test("remote image URLs are rejected by default", (t) => {
  delete process.env.AI_PROXY_ALLOW_REMOTE_IMAGES;
  const result = validateChatEvent(
    chatEvent({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
          ],
        },
      ],
    }),
  );
  assert.equal(result.error.code, "REMOTE_IMAGE_NOT_ALLOWED");
});

test("remote images can be enabled explicitly", (t) => {
  process.env.AI_PROXY_ALLOW_REMOTE_IMAGES = "true";
  t.after(() => {
    delete process.env.AI_PROXY_ALLOW_REMOTE_IMAGES;
  });
  const result = validateChatEvent(
    chatEvent({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/cat.png" } }],
        },
      ],
    }),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.params.messages[0].content[0].image_url.url, "https://example.com/cat.png");
});

test("inline data: images still work", () => {
  const result = validateChatEvent(
    chatEvent({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }],
        },
      ],
    }),
  );
  assert.equal(result.error, undefined);
});

test("maxTokens is clamped", () => {
  const result = validateChatEvent(chatEvent({ maxTokens: 999_999 }));
  assert.equal(result.error, undefined);
  assert.equal(result.params.maxTokens, MAX_OUTPUT_TOKENS);
});

test("models outside the allowlist are rejected", () => {
  const result = validateChatEvent(chatEvent({ model: "gpt-4" }));
  assert.equal(result.error.code, "MODEL_NOT_ALLOWED");
});

test("empty messages are rejected", () => {
  const result = validateChatEvent(chatEvent({ messages: [] }));
  assert.equal(result.error.code, "INVALID_REQUEST");
});

test("upstream error messages are hidden unless explicitly exposed", () => {
  const hidden = failureEnvelope(
    { code: "UPSTREAM_ERROR", message: "account 12345 quota details" },
    "req-1",
  );
  assert.equal(hidden.error.message.includes("account 12345"), false);
  assert.equal(hidden.error.requestId, "req-1");

  const visible = new Error("actionable message");
  visible.expose = true;
  visible.code = "CONFIG_ERROR";
  assert.equal(failureEnvelope(visible).error.message, "actionable message");
});

test("the production build has no test override hook", () => {
  assert.equal(fn._callModelOverride, undefined);
});

test("event.extra is validated and reaches the SDK call", () => {
  const result = validateChatEvent(chatEvent({ extra: { thinking: { type: "disabled" } } }));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.params.extra, { thinking: { type: "disabled" } });
  const input = fn._internal.buildGenerateInput(result.params);
  assert.deepEqual(input.thinking, { type: "disabled" });
  assert.equal(input.model, "hy4");
  assert.equal(input.messages.length, 1);
});

test("event.extra rejects unknown keys, bad shapes and model/message overrides", () => {
  for (const extra of [
    { model: "hy3" },
    { messages: [] },
    { max_tokens: 1 },
    { thinking: { type: "maybe" } },
    { enable_thinking: "yes" },
    { chat_template_kwargs: { other: true } },
  ]) {
    const result = validateChatEvent(chatEvent({ extra }));
    assert.equal(result.error.code, "INVALID_REQUEST", JSON.stringify(extra));
  }
});

test("no extra means no extra fields on the SDK input", () => {
  const result = validateChatEvent(chatEvent());
  assert.equal(result.error, undefined);
  const input = fn._internal.buildGenerateInput(result.params);
  assert.equal("thinking" in input, false);
  assert.equal("reasoning_effort" in input, false);
});
