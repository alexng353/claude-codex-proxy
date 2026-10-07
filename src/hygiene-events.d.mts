export function responseEvents(response: { output: unknown[] } & Record<string, unknown>): Array<Record<string, unknown>>;
export function sseBody(response: { output: unknown[] } & Record<string, unknown>): string;
export function askGate(
  gateUrl: string,
  body: unknown,
  options?: { timeoutMs?: number },
): Promise<{ action: "forward"; request?: unknown } | { action: "respond"; response: Record<string, unknown> } | null>;
