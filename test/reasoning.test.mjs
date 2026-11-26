import test from "node:test";
import assert from "node:assert/strict";
import { REASONING_PARAM_KEYS, validateReasoningParams } from "../src/reasoning.mjs";

test("the allowlist is exactly the documented four names", () => {
  assert.deepEqual([...REASONING_PARAM_KEYS], [
    "reasoning_effort",
    "thinking",
    "enable_thinking",
    "chat_template_kwargs",
  ]);
});

test("an empty set of reasoning parameters is valid", () => {
  const result = validateReasoningParams({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {});
});

test("values are normalized (case and shape)", () => {
  const result = validateReasoningParams({
    reasoning_effort: " NONE ",
    thinking: { type: "Disabled", budget_tokens: 2048 },
    enable_thinking: false,
    chat_template_kwargs: { enable_thinking: false },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    reasoning_effort: "none",
    thinking: { type: "disabled", budget_tokens: 2048 },
    enable_thinking: false,
    chat_template_kwargs: { enable_thinking: false },
  });
});

test("anything outside the allowlist is rejected, model and messages included", () => {
  for (const raw of [{ max_tokens: 1 }, { model: "hy3" }, { messages: [] }, { extra: {} }]) {
    const result = validateReasoningParams(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.match(result.message, /accepts only/);
  }
});

test("malformed values are rejected without echoing them", () => {
  const cases = [
    { thinking: "disabled" },
    { thinking: { type: "maybe" } },
    { thinking: { type: "enabled", budget_tokens: 12 } },
    { thinking: { type: "enabled", budget_tokens: "many" } },
    { thinking: { type: "enabled", other: 1 } },
    { enable_thinking: "yes" },
    { chat_template_kwargs: { enable_thinking: "no" } },
    { chat_template_kwargs: { other: true } },
    { chat_template_kwargs: [] },
  ];
  for (const raw of cases) {
    const result = validateReasoningParams(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(typeof result.message, "string");
  }
});

test("effort levels a host uses are mapped onto the supported ones", () => {
  assert.equal(validateReasoningParams({ reasoning_effort: "max" }).value.reasoning_effort, "high");
  assert.equal(validateReasoningParams({ reasoning_effort: "xhigh" }).value.reasoning_effort, "high");
  assert.equal(validateReasoningParams({ reasoning_effort: "priority" }).value.reasoning_effort, "high");
  assert.equal(validateReasoningParams({ reasoning_effort: "min" }).value.reasoning_effort, "minimal");
  assert.equal(validateReasoningParams({ reasoning_effort: "none" }).value.reasoning_effort, "none");
});

test("an effort level with no equivalent is dropped, never fatal", () => {
  const word = validateReasoningParams({ reasoning_effort: "turbo" });
  assert.equal(word.ok, true);
  assert.deepEqual(word.value, {});
  assert.deepEqual(word.dropped, ["reasoning_effort"]);

  const number = validateReasoningParams({ reasoning_effort: 3 });
  assert.equal(number.ok, true);
  assert.deepEqual(number.dropped, ["reasoning_effort"]);

  const kept = validateReasoningParams({ reasoning_effort: "turbo", enable_thinking: false });
  assert.deepEqual(kept.value, { enable_thinking: false });
  assert.deepEqual(kept.dropped, ["reasoning_effort"]);
});

test("an oversized value is rejected", () => {
  const result = validateReasoningParams({ thinking: { type: "enabled", budget_tokens: 100_000 } });
  assert.equal(result.ok, true);
  const padded = validateReasoningParams({
    thinking: { type: "enabled", budget_tokens: 100_000 },
    chat_template_kwargs: { enable_thinking: true },
  });
  assert.equal(padded.ok, true);
  assert.ok(JSON.stringify(padded.value).length <= 512);
});
