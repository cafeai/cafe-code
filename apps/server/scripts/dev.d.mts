export function createServerDevelopmentController<A>(options: {
  start: () => A;
  qualify: () => string | undefined;
  stop: (child: A) => Promise<void>;
}): { built: () => Promise<void>; close: () => Promise<void> };
export function runServerDevelopment(environment?: NodeJS.ProcessEnv): Promise<void>;
