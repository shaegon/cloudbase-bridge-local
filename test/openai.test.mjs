import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.mjs";
import {
  parseChatRequest,
  normalizeCompletion,
  toChatCompletion,
  sseFrames,
  stripModelPrefix,
} from "../src/openai.mjs";
import { RequestError } from "../src/errors.mjs";

const baseConfig = validateConfig({
  envId: "cloud1-test",
  localToken: "t".repeat(40),
  models: ["hy3", "hy4"],
});

test("stripModelPrefix removes known provider prefixes only", () => {
  assert.equal(stripModelPrefix("cloudbase/hy3"), "hy3");
  assert.equal(stripModelPrefix("cloudbase-plugin/cloudbase/hy3"), "hy3");
  assert.equal(stripModelPrefix("openai/gpt"), "openai/gpt");
  assert.equal(stripModelPrefix(42), "");
});

test("arbitrary provider prefixes work when the tail is an allowed model", () => {
  const { event } = parseChatRequest(
    { model: "my-provider/hy3", messages: [{ role: "user", content: "hi" }] },
    baseConfig,
  );
  assert.equal(event.model, "hy3");
});

test("parseChatRequest builds the aiProxy event", () => {
  const { event, stream, requestedModel } = parseChatRequest(
    {
      model: "cloudbase/hy3",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 100,
      stream: false,
    },
    baseConfig,
  );
  assert.equal(stream, false);
  assert.equal(requestedModel, "cloudbase/hy3");
  assert.deepEqual(event, {
    action: "chat",
    model: "hy3",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.5,
    topP: 0.9,
    maxTokens: 100,
  });
});

test("unknown model is rejected with 404", () => {
  assert.throws(
    () => parseChatRequest({ model: "hy3-evil", messages: [{ role: "user", content: "hi" }] }, baseConfig),
    (error) => error instanceof RequestError && error.status === 404 && error.code === "model_not_found",
  );
});

test("remote image URLs are rejected by default", () => {
  const body = {
    model: "hy3",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      },
    ],
  };
  assert.throws(
    () => parseChatRequest(body, baseConfig),
    (error) => error.code === "remote_image_not_allowed" && error.status === 400,
  );
});

test("data:image URLs are accepted", () => {
  const { event } = parseChatRequest(
    {
      model: "hy3",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          ],
        },
      ],
    },
    baseConfig,
  );
  assert.equal(event.messages[0].content[1].image_url.url.startsWith("data:image/png"), true);
});

test("remote images are allowed only when explicitly enabled", () => {
  const permissive = validateConfig({
    envId: "cloud1-test",
    localToken: "t".repeat(40),
    models: ["hy3"],
    allowRemoteImages: true,
  });
  const { event } = parseChatRequest(
    {
      model: "hy3",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/cat.png" } }],
        },
      ],
    },
    permissive,
  );
  assert.equal(event.messages[0].content[0].image_url.url, "https://example.com/cat.png");
});

test("max_tokens is clamped to the configured ceiling", () => {
  const config = validateConfig({
    envId: "cloud1-test",
    localToken: "t".repeat(40),
    models: ["hy3"],
    maxOutputTokens: 1000,
  });
  const result = parseChatRequest(
    { model: "hy3", messages: [{ role: "user", content: "hi" }], max_tokens: 999_999 },
    config,
  );
  assert.equal(result.event.maxTokens, 1000);
  assert.deepEqual(result.clampedMaxTokens, { requested: 999_999, used: 1000 });
});

test("bad sampling parameters are rejected", () => {
  assert.throws(
    () =>
      parseChatRequest(
        { model: "hy3", messages: [{ role: "user", content: "hi" }], temperature: 3 },
        baseConfig,
      ),
    (error) => error.status === 400,
  );
  assert.throws(
    () =>
      parseChatRequest(
        { model: "hy3", messages: [{ role: "user", content: "hi" }], top_p: "high" },
        baseConfig,
      ),
    (error) => error.status === 400,
  );
});

test("completion normalization keeps tool calls and finish_reason", () => {
  const completion = normalizeCompletion({
    id: "chatcmpl-1",
    created: 123,
    model: "hy3",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"p":"a"}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
  assert.equal(completion.finishReason, "tool_calls");
  assert.equal(completion.toolCalls.length, 1);
  assert.equal(completion.usage.total_tokens, 7);
  const payload = toChatCompletion(completion, "cloudbase/hy3");
  assert.equal(payload.model, "cloudbase/hy3");
  assert.equal(payload.choices[0].message.content, null);
  assert.equal(payload.choices[0].message.tool_calls[0].function.name, "read_file");
});

test("truncated replies stay finish_reason=length", () => {
  const completion = normalizeCompletion({
    choices: [
      {
        message: { content: "partial" },
        finish_reason: "length",
      },
    ],
  });
  assert.equal(completion.finishReason, "length");
});

test("SSE frames end with [DONE] and carry the content", () => {
  const completion = normalizeCompletion({
    id: "id-1",
    created: 1,
    choices: [{ message: { role: "assistant", content: "hello world" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  const frames = [...sseFrames(completion, "cloudbase/hy3")];
  assert.equal(frames.at(-1), "data: [DONE]\n\n");
  assert.ok(frames.some((frame) => frame.includes("hello")));
  assert.ok(frames.every((frame) => !frame.includes("[object Object]")));
});

test("reasoning fields a client sends are forwarded, and listed for the log", () => {
  const { event, extraKeys } = parseChatRequest(
    {
      model: "hy4",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    },
    baseConfig,
  );
  assert.deepEqual(event.extra, { thinking: { type: "disabled" } });
  assert.deepEqual(extraKeys, ["thinking"]);
});

test("a request with no reasoning fields leaves the event as it was", () => {
  const { event, extraKeys } = parseChatRequest(
    { model: "hy4", messages: [{ role: "user", content: "hi" }] },
    baseConfig,
  );
  assert.equal("extra" in event, false);
  assert.deepEqual(extraKeys, []);
});

test("config extraParams apply to that model, and the request can add to them", () => {
  const config = validateConfig({
    envId: "cloud1-test",
    localToken: "t".repeat(40),
    models: ["hy4", "hy3"],
    extraParams: { hy4: { thinking: { type: "disabled" } } },
  });
  const forced = parseChatRequest({ model: "hy4", messages: [{ role: "user", content: "hi" }] }, config);
  assert.deepEqual(forced.event.extra, { thinking: { type: "disabled" } });

  const other = parseChatRequest({ model: "hy3", messages: [{ role: "user", content: "hi" }] }, config);
  assert.equal("extra" in other.event, false);

  const added = parseChatRequest(
    { model: "hy4", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
    config,
  );
  assert.deepEqual(added.event.extra, { thinking: { type: "disabled" }, reasoning_effort: "high" });
});

test("a guarded entry applies only below its budget, and the client can still override it", () => {
  const config = validateConfig({
    envId: "cloud1-test",
    localToken: "t".repeat(40),
    models: ["hy4"],
    extraParams: { hy4: { when: { maxTokensAtMost: 4096 }, params: { thinking: { type: "disabled" } } } },
  });

  const small = parseChatRequest(
    { model: "hy4", messages: [{ role: "user", content: "hi" }], max_tokens: 2112 },
    config,
  );
  assert.deepEqual(small.event.extra, { thinking: { type: "disabled" } });
  assert.equal(small.reasoningGuard, 4096);

  const large = parseChatRequest(
    { model: "hy4", messages: [{ role: "user", content: "hi" }], max_tokens: 16_000 },
    config,
  );
  assert.equal("extra" in large.event, false);
  assert.equal(large.reasoningGuard, null);

  const unbounded = parseChatRequest({ model: "hy4", messages: [{ role: "user", content: "hi" }] }, config);
  assert.equal("extra" in unbounded.event, false);

  const explicit = parseChatRequest(
    {
      model: "hy4",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 2112,
      reasoning_effort: "high",
    },
    config,
  );
  assert.deepEqual(explicit.event.extra, {
    thinking: { type: "disabled" },
    reasoning_effort: "high",
  });

  const clamped = parseChatRequest(
    { model: "hy4", messages: [{ role: "user", content: "hi" }], max_tokens: 999_999 },
    validateConfig({
      envId: "cloud1-test",
      localToken: "t".repeat(40),
      models: ["hy4"],
      maxOutputTokens: 1000,
      extraParams: { hy4: { when: { maxTokensAtMost: 4096 }, params: { thinking: { type: "disabled" } } } },
    }),
  );
  assert.deepEqual(clamped.event.extra, { thinking: { type: "disabled" } });
});

test("an unknown reasoning field is a 400, not a silent drop", () => {
  assert.throws(
    () =>
      parseChatRequest(
        { model: "hy4", messages: [{ role: "user", content: "hi" }], extra: { temperature2: 1 } },
        baseConfig,
      ),
    (error) => error instanceof RequestError && error.status === 400 && error.code === "invalid_reasoning_params",
  );
});

test("a host's effort level is mapped, and an unmappable one is dropped but served", () => {
  const mapped = parseChatRequest(
    { model: "hy4", messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" },
    baseConfig,
  );
  assert.deepEqual(mapped.event.extra, { reasoning_effort: "high" });
  assert.deepEqual(mapped.droppedExtraKeys, []);

  const dropped = parseChatRequest(
    { model: "hy4", messages: [{ role: "user", content: "hi" }], reasoning_effort: "turbo" },
    baseConfig,
  );
  assert.equal("extra" in dropped.event, false);
  assert.deepEqual(dropped.droppedExtraKeys, ["reasoning_effort"]);
});
