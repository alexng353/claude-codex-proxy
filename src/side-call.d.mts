export const SIDE_CALL_MARKER: "<today-side-call/>";
export const SIDE_MODEL_ALIASES: Readonly<Record<string, string>>;
export const SIDE_CALL_REFUSED_CODE: "side_call_tools_refused";
export function isSideCall(request: unknown): boolean;
export function carriedTools(request: unknown): string[];
export function refuseFlagPath(env?: Record<string, string | undefined>): string;
export function refuseEnabled(env?: Record<string, string | undefined>, exists?: (path: string) => boolean): boolean;
export function sideCallCheck(request: unknown, options?: { refuse?: boolean }): { tools: string[]; refuse: boolean } | null;
export function sideCallConnection(): {
  check(frame: unknown, options?: { refuse?: boolean }): { tools: string[]; refuse: boolean; sticky: boolean } | null;
};
export function refusalMessage(model: string | undefined | null, tools: string[]): string;
export function refusalBody(
  model: string | undefined | null,
  tools: string[],
): { error: { type: string; code: string; message: string } };
export function refusalFrame(
  model: string | undefined | null,
  tools: string[],
): { type: "error"; status: 400; error: { type: string; code: string; message: string } };
export function wireModel<T>(model: T): T | string;
export function aliasRequest<T>(request: T): T;
export function aliasMetadataHeader<T>(value: T): T | string;
export function aliasHeaders<T extends Record<string, unknown> | undefined>(headers: T): T;
