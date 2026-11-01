import { validAgentName } from "./agent-identity";
import { refuseLocal } from "./pins";
import { listThreadAgentNames, setThreadAgentName, threadAgentName } from "./sessions";

/**
 * Local API over each chat's agent name (agent-identity.ts), with the same
 * access rules as /pins: loopback peers, no browsers, and writes need this
 * machine's pins.token (or PROXY_API_KEY).
 *
 *   GET  /agent-names[?threadId=ID]   list, or one chat ({threadId, name|null})
 *   POST /agent-names {threadId, name}  set; name null clears
 *
 * Keys are Codex thread ids (prompt_cache_key). A change applies from the
 * chat's next turn.
 */

const THREAD_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export async function handleAgentNamesRoute(request: Request, url: URL, peer?: string): Promise<Response | undefined> {
  if (url.pathname !== "/agent-names") return undefined;
  const fail = (message: string, status: number) =>
    Response.json({ error: { message, type: "invalid_request_error" } }, { status });
  try {
    const refused = refuseLocal(request, url, peer, "Agent names");
    if (refused) return refused;
    if (request.method === "GET") {
      const threadId = url.searchParams.get("threadId");
      if (threadId === null) return Response.json({ agentNames: listThreadAgentNames() });
      if (!THREAD_ID.test(threadId)) return fail(`Invalid thread id ${JSON.stringify(threadId)}`, 400);
      return Response.json({ threadId, name: threadAgentName(threadId) ?? null });
    }
    if (request.method !== "POST") return fail("Not found", 404);
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return fail("Body must be JSON", 400);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("Body must be {threadId, name}", 400);
    const body = input as Record<string, unknown>;
    const extra = Object.keys(body).find((key) => key !== "threadId" && key !== "name");
    if (extra) return fail(`Agent names take threadId and name; ${JSON.stringify(extra)} is not one of them`, 400);
    if (typeof body.threadId !== "string" || !THREAD_ID.test(body.threadId))
      return fail(`Invalid thread id ${JSON.stringify(body.threadId)}`, 400);
    if (!("name" in body)) return fail("name is required (null clears it)", 400);
    if (body.name !== null && !validAgentName(body.name))
      return fail("name must be 1 to 40 letters, digits, spaces and ' , & -, starting with a letter or digit, not ending in a space, and without the words powered, model, GPT, Claude, OpenAI or Anthropic", 400);
    const name = body.name === null ? undefined : (body.name as string);
    const previous = setThreadAgentName(body.threadId, name);
    return Response.json({ threadId: body.threadId, name: name ?? null, previous: previous ?? null });
  } catch (cause) {
    return fail(`Agent names: ${(cause as Error).message}`, 500);
  }
}
