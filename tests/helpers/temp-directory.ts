import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

// Registers cleanup with the calling test file, so every directory created through this helper
// disappears after each test even when the test fails.
export function useTemporaryDirectories(): (prefix: string) => Promise<string> {
  const createdDirectories: string[] = [];
  afterEach(async () => {
    for (const directory of createdDirectories.splice(0)) await rm(directory, {
        recursive: true,
        force: true,
        // detached comm-log appends may still be landing while the test ends
        maxRetries: 8,
        retryDelay: 25,
      });
  });
  return async (prefix: string) => {
    const directory = await mkdtemp(join(tmpdir(), `slp-test-${prefix}-`));
    createdDirectories.push(directory);
    return directory;
  };
}
