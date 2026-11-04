import { describe, expect, it } from "vitest";
import {
  SANDBOX_FILE_MAX_BYTES,
  SandboxListFilesInputSchema,
  SandboxReadFileInputSchema,
  SandboxReadFilesInputSchema,
  SandboxWriteFileInputSchema,
} from "@meta-game/contracts";

describe("sandbox filesystem tool contracts", () => {
  it("accepts workspace-relative files and the workspace root for listing", () => {
    expect(SandboxReadFileInputSchema.safeParse({ path: "src/main.ts" }).success).toBe(true);
    expect(SandboxListFilesInputSchema.safeParse({}).success).toBe(true);
    expect(SandboxWriteFileInputSchema.safeParse({ path: "src/main.ts", content: "export {};" }).success).toBe(true);
  });

  it.each(["../secret", "src/../../secret", "/etc/passwd", "C:\\Windows\\win.ini", "src\\main.ts", "src//main.ts", "src/./main.ts", "x\u0000y"])(
    "rejects unsafe path %s before contacting the runtime",
    (path) => {
      expect(SandboxReadFileInputSchema.safeParse({ path }).success).toBe(false);
      expect(SandboxWriteFileInputSchema.safeParse({ path, content: "x" }).success).toBe(false);
    },
  );

  it("accepts a bounded unique batch of workspace paths for bulk reads", () => {
    expect(SandboxReadFilesInputSchema.safeParse({ paths: ["src/main.ts", "src/game.ts"] }).success).toBe(true);
    expect(SandboxReadFilesInputSchema.safeParse({ paths: [] }).success).toBe(false);
    expect(SandboxReadFilesInputSchema.safeParse({ paths: ["src/main.ts", "src/main.ts"] }).success).toBe(false);
    expect(SandboxReadFilesInputSchema.safeParse({ paths: ["../secret"] }).success).toBe(false);
    expect(SandboxReadFilesInputSchema.safeParse({ paths: Array.from({ length: 65 }, (_, i) => `src/f${i}.ts`) }).success).toBe(false);
  });

  it("caps UTF-8 file contents at one MiB", () => {
    const accepted = "a".repeat(SANDBOX_FILE_MAX_BYTES);
    const oversized = "a".repeat(SANDBOX_FILE_MAX_BYTES + 1);
    expect(SandboxWriteFileInputSchema.safeParse({ path: "game.js", content: accepted }).success).toBe(true);
    expect(SandboxWriteFileInputSchema.safeParse({ path: "game.js", content: oversized }).success).toBe(false);
  });
});
