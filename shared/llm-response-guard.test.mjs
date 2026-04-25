import assert from "node:assert/strict";
import test from "node:test";
import { classifyLlmText, isUsableLlmText } from "./llm-response-guard.mjs";

test("classifyLlmText rejects empty / whitespace-only responses", () => {
  assert.deepEqual(classifyLlmText(""), { ok: false, reason: "empty" });
  assert.deepEqual(classifyLlmText("   \n\t  "), { ok: false, reason: "empty" });
  assert.deepEqual(classifyLlmText(null), { ok: false, reason: "empty" });
  assert.deepEqual(classifyLlmText(undefined), { ok: false, reason: "empty" });
});

test("classifyLlmText rejects too-short responses below the minimum", () => {
  assert.deepEqual(classifyLlmText("ok"), { ok: false, reason: "too-short" });
  assert.deepEqual(classifyLlmText("Hi."), { ok: false, reason: "too-short" });
  assert.deepEqual(
    classifyLlmText("short", { minChars: 20 }),
    { ok: false, reason: "too-short" }
  );
});

test("classifyLlmText flags canonical LLM refusal phrasings", () => {
  const refusals = [
    "I can't help with that.",
    "I cannot assist with this request.",
    "I'm sorry, but I can't help with that.",
    "I am unable to fulfil this request.",
    "As an AI language model, I do not have access to...",
    "As an AI model, I cannot provide that.",
    "I don't have the ability to browse the web.",
    "I do not have the ability to generate that content.",
    "This request goes against my guidelines.",
    "I'm not able to comply with that."
  ];
  for (const text of refusals) {
    const result = classifyLlmText(text);
    assert.equal(result.ok, false, `expected refusal detection for: ${text}`);
    assert.equal(result.reason, "refusal");
  }
});

test("classifyLlmText accepts normal brand copy", () => {
  const acceptable = [
    "AutoCRM packages sales AI into workflows operators can adopt quickly.",
    "Launch teams need execution that keeps brand context intact.",
    "The market signal favours tools that tie AI output to workflows."
  ];
  for (const text of acceptable) {
    assert.deepEqual(classifyLlmText(text), { ok: true }, text);
  }
});

test("isUsableLlmText is the boolean shortcut for classifyLlmText", () => {
  assert.equal(isUsableLlmText("Long enough copy for the default minimum."), true);
  assert.equal(isUsableLlmText(""), false);
  assert.equal(isUsableLlmText("I cannot help with that specific ask right now."), false);
});
