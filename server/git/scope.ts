// Pure path-scope rules. Kept free of I/O so the scope gate (spec phase 3, "physical checkpoint")
// can be unit tested without a git repository.

// Reserve obsolete pipeline filenames so broad writable scopes cannot reintroduce task/report litter.
export const PROTECTED_TASK_FILES = ["TASK_SPEC.md", ".slp/MASTER_SPEC.md", ".slp/ACCEPTANCE_DOC.md", ".slp/comm-log.jsonl"] as const;

export function normalizeRelativePath(filePath: string): string {
  // git prints forward slashes; users type "./src/" or "src\\" so normalise both forms
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function globToRegExp(scopeGlob: string): RegExp {
  const normalizedGlob = normalizeRelativePath(scopeGlob);
  // "src/" and "src" both mean "everything under src"
  const directoryGlob = /[*?]/.test(normalizedGlob) ? normalizedGlob : `${normalizedGlob}/**`;
  let expression = "";
  for (let index = 0; index < directoryGlob.length; index += 1) {
    const character = directoryGlob[index];
    if (character === "*" && directoryGlob[index + 1] === "*") {
      // "**/" must also match zero directories, so "**/x.ts" matches "x.ts"
      const followedBySlash = directoryGlob[index + 2] === "/";
      expression += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`);
}

export function matchesAnyScope(filePath: string, scopeGlobs: readonly string[]): boolean {
  const normalizedPath = normalizeRelativePath(filePath);
  // a bare directory name also covers the directory entry itself
  return scopeGlobs.some((scopeGlob) => {
    const normalizedGlob = normalizeRelativePath(scopeGlob);
    return normalizedPath === normalizedGlob || globToRegExp(scopeGlob).test(normalizedPath);
  });
}

export interface ScopeCheckInput {
  changedFiles: readonly string[];
  writableScope: readonly string[];
  // Extra globs allowed in this check when a stage peer receives supplemental path grants.
  additionalAllowedScope?: readonly string[];
}

export interface ScopeCheckOutcome {
  outOfScopeFiles: string[];
  protectedFileTouched: string[];
}

export function checkScope(input: ScopeCheckInput): ScopeCheckOutcome {
  const allowedScope = [...input.writableScope, ...(input.additionalAllowedScope ?? [])];
  const outOfScopeFiles: string[] = [];
  const protectedFileTouched: string[] = [];
  for (const changedFile of input.changedFiles) {
    const normalizedFile = normalizeRelativePath(changedFile);
    // Reports are submitted through tools; reserved files are rejected even inside an otherwise valid scope.
    if ((PROTECTED_TASK_FILES as readonly string[]).includes(normalizedFile)) {
      protectedFileTouched.push(normalizedFile);
      continue;
    }
    if (!matchesAnyScope(normalizedFile, allowedScope)) outOfScopeFiles.push(normalizedFile);
  }
  return { outOfScopeFiles, protectedFileTouched };
}

// Two work packages must not claim the same files (spec phase 1, step 3).
export function findScopeOverlaps(
  taskScopes: ReadonlyArray<{ id: string; writableScope: readonly string[] }>,
): string[] {
  const overlapDescriptions: string[] = [];
  for (let firstIndex = 0; firstIndex < taskScopes.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < taskScopes.length; secondIndex += 1) {
      const firstTask = taskScopes[firstIndex];
      const secondTask = taskScopes[secondIndex];
      // Conservative: a false overlap only asks the Lead to adjust the split, whereas a missed one causes merge conflicts later.
      // Comparing literal prefixes catches the common "src/a" vs "src/a/b" case without a glob solver.
      const overlappingPair = firstTask.writableScope.some((firstScope) =>
        secondTask.writableScope.some((secondScope) => scopesCollide(firstScope, secondScope)),
      );
      if (overlappingPair) overlapDescriptions.push(`${firstTask.id} overlaps ${secondTask.id}`);
    }
  }
  return overlapDescriptions;
}

function scopesCollide(firstScope: string, secondScope: string): boolean {
  const firstPrefix = literalPrefix(firstScope);
  const secondPrefix = literalPrefix(secondScope);
  return firstPrefix.startsWith(secondPrefix) || secondPrefix.startsWith(firstPrefix);
}

function literalPrefix(scopeGlob: string): string {
  const normalizedGlob = normalizeRelativePath(scopeGlob);
  const wildcardIndex = normalizedGlob.search(/[*?]/);
  const prefix = wildcardIndex === -1 ? normalizedGlob : normalizedGlob.slice(0, wildcardIndex);
  return prefix.endsWith("/") || wildcardIndex !== -1 ? prefix : `${prefix}/`;
}
