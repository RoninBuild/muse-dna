import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedFalImageUrl } from "./generator.js";

test("isTrustedFalImageUrl accepts canonical fal.ai hosts over HTTPS", () => {
  assert.equal(isTrustedFalImageUrl("https://fal.run/fal-ai/flux/schnell/output.png"), true);
  assert.equal(isTrustedFalImageUrl("https://fal.media/files/abc.png"), true);
  assert.equal(isTrustedFalImageUrl("https://v2.fal.media/cdn/image.png"), true);
  assert.equal(isTrustedFalImageUrl("https://v3.fal.media/cdn/image.png"), true);
  assert.equal(isTrustedFalImageUrl("https://cdn.fal.ai/users/abc.png"), true);
  assert.equal(isTrustedFalImageUrl("https://storage.fal.ai/bucket/x.png"), true);
});

test("isTrustedFalImageUrl accepts subdomains of the allowlist", () => {
  assert.equal(isTrustedFalImageUrl("https://foo.fal.run/x.png"), true);
  assert.equal(isTrustedFalImageUrl("https://deep.nested.fal.media/x.png"), true);
});

test("isTrustedFalImageUrl rejects protocol downgrade (http://)", () => {
  assert.equal(isTrustedFalImageUrl("http://fal.run/x.png"), false);
});

test("isTrustedFalImageUrl rejects data:// and javascript:// URIs", () => {
  assert.equal(isTrustedFalImageUrl("data:image/png;base64,AAA"), false);
  assert.equal(isTrustedFalImageUrl("javascript:alert(1)"), false);
  assert.equal(isTrustedFalImageUrl("file:///etc/passwd"), false);
});

test("isTrustedFalImageUrl rejects off-allowlist hosts even over HTTPS", () => {
  assert.equal(isTrustedFalImageUrl("https://attacker.com/image.png"), false);
  assert.equal(isTrustedFalImageUrl("https://fake-fal.run.attacker.com/x.png"), false);
  assert.equal(isTrustedFalImageUrl("https://fal.run.attacker.com/x.png"), false);
});

test("isTrustedFalImageUrl rejects malformed / non-string input", () => {
  assert.equal(isTrustedFalImageUrl(null), false);
  assert.equal(isTrustedFalImageUrl(undefined), false);
  assert.equal(isTrustedFalImageUrl(""), false);
  assert.equal(isTrustedFalImageUrl(123), false);
  assert.equal(isTrustedFalImageUrl("not a url"), false);
});
