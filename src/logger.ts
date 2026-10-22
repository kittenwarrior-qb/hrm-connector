// PM2 tự gắn timestamp (time: true), nên chỉ cần scope.
export function logger(scope: string) {
  const tag = `[${scope}]`;
  return {
    info: (...args: unknown[]) => console.log(tag, ...args),
    warn: (...args: unknown[]) => console.warn(tag, ...args),
    error: (...args: unknown[]) => console.error(tag, ...args),
  };
}

export type Logger = ReturnType<typeof logger>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
