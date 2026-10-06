export type Scrubber = {
  scrub(text: string): string;
  scrubRequest<T>(request: T): T;
  names(): string[];
};
export function createScrubber(options?: {
  files?: string[];
  refreshMs?: number;
  load?: (file: string) => Map<string, string>;
  now?: () => number;
}): Scrubber;
export function loadSecretFile(file: string): Map<string, string>;
export function isSecretValue(name: string, value: string): boolean;
export function defaultSecretFiles(env?: Record<string, string | undefined>): string[];
export function scrubRequest<T>(request: T): T;
export function scrubText(text: string): string;
