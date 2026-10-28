#!/usr/bin/env bun
import { credentialExpiry, flushAuthWarnings, sendTodayWarning, type WarningSender } from "../src/auth-health";
import { listAccounts } from "../src/accounts";
import { probeAllAccounts } from "../src/usage-probe";

/** /usage runs locally and refreshes due OAuth tokens without a model request.
 * It is safe for capped/rate-limited accounts too; unsupported CLIs fail closed.
 */
export async function loginKeepalive(send: WarningSender) {
  const before = new Map(listAccounts().map((a) => [a.name, credentialExpiry(a)]));
  const outcomes = await probeAllAccounts();
  await flushAuthWarnings(send);
  return outcomes.map((outcome) => {
    const account = listAccounts().find((a) => a.name === outcome.account)!;
    return { ...outcome, before: before.get(account.name), after: credentialExpiry(account) };
  });
}
if (import.meta.main) {
  try {
    const outcomes = await loginKeepalive(sendTodayWarning);
    for (const outcome of outcomes) console.log(JSON.stringify(outcome));
    if (outcomes.some((o) => o.result !== "applied" && o.result !== "newer data")) process.exitCode = 1;
  } catch {
    console.error("Login keepalive failed; check the proxy account authentication state");
    process.exitCode = 1;
  }
}
