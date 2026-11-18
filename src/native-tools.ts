/**
 * Claude sometimes calls a Codex tool as a native Claude tool_use. The proxy launches
 * Claude Code with `--tools ""`, so Claude Code answers "No such tool available" inside
 * the same query and the model concludes its tools are broken. The guard below turns
 * that into one corrective turn naming the exact Codex tool, so the model returns it
 * in StructuredOutput tool_calls instead.
 *
 * Logs carry tool names and session ids only: never arguments, reply text or tool
 * results, which can hold anything the chat was working on.
 */

/** Corrective messages one Codex turn may send before native calls fail the turn. */
export const MAX_NUDGES = 2;

const MCP_PREFIX = "mcp__";

/**
 * The exact Codex tool name a native tool_use name means, taken from `allowed` (the
 * request's tool list), or undefined when it means none of them.
 */
export function codexToolFor(native: string, allowed: ReadonlySet<string>): string | undefined {
  const bare = native.startsWith(MCP_PREFIX) ? native.slice(MCP_PREFIX.length) : native;
  const candidates = [native];
  // Claude Code spells MCP tools mcp__server__tool. Codex lists them as
  // mcp__server.tool (Today's own tools come under both mcp__today and today), so
  // that spelling is tried before server.tool.
  const split = bare.indexOf("__");
  if (bare !== native && split > 0) {
    const tool = `${bare.slice(0, split)}.${bare.slice(split + 2)}`;
    candidates.push(`${MCP_PREFIX}${tool}`, bare, tool);
  } else candidates.push(bare);
  for (const candidate of candidates) if (allowed.has(candidate)) return candidate;
  // A bare name (create_thread) means a namespaced tool only when exactly one matches.
  if (bare.includes(".") || split > 0) return undefined;
  const matches = [...allowed].filter((name) => name.endsWith(`.${bare}`));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Nudges sent so far for one Codex request, shared by all its account attempts. */
export type NudgeState = { nudged: Set<string>; count: number };

export const newNudgeState = (): NudgeState => ({ nudged: new Set(), count: 0 });

export function nudgeMessage(names: readonly string[]): string {
  const lines = names.map(
    (name) =>
      `\`${name}\` is a Codex tool. Call it by returning it in StructuredOutput tool_calls: {"name":${JSON.stringify(name)},"arguments":"<json string>"}`,
  );
  return `<tool_error>\nNo tool ran: you called a Codex tool as a native Claude tool, and Claude Code has no native tools here.\n${lines.join("\n")}\nReply again with the corrected text and tool_calls.\n</tool_error>`;
}

/**
 * Checks one worker's answers for native calls. `check` returns the corrective
 * message to send for an answer, or undefined when there is nothing to correct; it
 * throws when the model keeps calling natively, so the turn ends with a visible
 * error. The caps live in `state`, which a failover to another account keeps.
 */
export class NativeToolGuard {
  constructor(
    private readonly allowed: ReadonlySet<string>,
    private readonly sessionId: string,
    private readonly state: NudgeState,
  ) {}

  check(nativeNames: readonly string[], toolCalls: readonly { name: string }[]): string | undefined {
    // A name the answer already calls properly needs no correction.
    const called = new Set(toolCalls.map((call) => call.name));
    const pending = [
      ...new Set(nativeNames.map((name) => codexToolFor(name, this.allowed))),
    ].filter((name): name is string => name !== undefined && !called.has(name));
    if (pending.length === 0) return undefined;
    const repeat = pending.find((name) => this.state.nudged.has(name));
    if (repeat)
      throw new Error(
        `Claude called Codex tool ${repeat} as a native tool again after a correction (session ${this.sessionId}); no tool ran`,
      );
    if (this.state.count >= MAX_NUDGES)
      throw new Error(
        `Claude kept calling Codex tools as native tools after ${MAX_NUDGES} corrections: ${pending[0]} (session ${this.sessionId}); no tool ran`,
      );
    this.state.count++;
    for (const name of pending) {
      this.state.nudged.add(name);
      console.log(JSON.stringify({ nativeToolNudge: { sessionId: this.sessionId, name } }));
    }
    return nudgeMessage(pending);
  }
}

// Past-tense narration of the user in the reply he reads ("Told Alex ..."), which
// belongs in a log, not in the answer. Case-sensitive and anchored, so a first-person
// "I told Hinson ..." is not counted.
const THIRD_PERSON = /^(Told|Giving|Gave|Pointed|Offered|Asked) (Alex|him|the user)\b/;
let thirdPersonCount = 0;

export function thirdPersonVerb(text: string): string | undefined {
  return THIRD_PERSON.exec(text.trimStart())?.[1];
}

/** Logs a third-person reply opening (session id, verb, running count); text is unchanged. */
export function noteThirdPerson(text: string, sessionId: string): string | undefined {
  const verb = thirdPersonVerb(text);
  if (!verb) return undefined;
  thirdPersonCount++;
  console.log(JSON.stringify({ thirdPersonText: { sessionId, verb, count: thirdPersonCount } }));
  return verb;
}
