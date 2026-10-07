export type PlateEvent = {
  id: number;
  at: string;
  actor: "alex" | "agent";
  action: string;
  key?: string;
  detail?: string;
};
export type PlateActivityConfig = {
  threads: Set<string>;
  plateUrl: string;
  timeZone?: string;
};
export const BLOCK_TAG: string;
export type MessageKey = { index: number; key: string; hasBlock: boolean };
export function messageKeys(input: unknown): MessageKey[];
export function targetMessage(input: unknown): MessageKey | null;
export function injectBlock<T extends { input: unknown[] }>(request: T, index: number, block: string): T;
export function relevantEvent(event: PlateEvent): boolean;
export function renderBlock(
  events: PlateEvent[],
  options?: { timeZone?: string; truncated?: boolean },
): string | null;
export function configPath(env?: Record<string, string | undefined>): string;
export function loadConfig(path?: string): PlateActivityConfig | null;
