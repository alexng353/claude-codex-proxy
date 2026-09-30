import { expect, test } from "bun:test";
import { isLimited, markLimited, observeRateLimit, resetAccountState } from "../src/accounts";

test("a generic quota error preserves an already reported short reset", () => {
  resetAccountState();
  const account = { name: "short-reset", dir: "/unused", isDefault: false };
  const reset = Math.ceil(Date.now() / 1000) + 60;
  try {
    observeRateLimit(account, { status: "rejected", resetsAt: reset });
    markLimited(account);
    expect(isLimited(account, reset * 1000 - 1)).toBe(true);
    expect(isLimited(account, reset * 1000)).toBe(false);
  } finally {
    resetAccountState();
  }
});
