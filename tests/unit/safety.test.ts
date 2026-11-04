import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isSensitiveWorkspacePath, sensitiveInputReason, sensitiveWorkspaceContentReason } from "../../apps/worker/src/agent/safety";

describe("sensitive workspace scanning", () => {
  it("keeps package-manager and credential config out of workspace snapshots", () => {
    for (const path of [".npmrc", ".yarnrc.yml", ".pypirc", ".git-credentials", "src/credentials.json", "src/id_ed25519"]) {
      expect(isSensitiveWorkspacePath(path)).toBe(true);
    }
    expect(isSensitiveWorkspacePath("package-lock.json")).toBe(false);
  });

  it("continues to block phone numbers in user text", () => {
    expect(sensitiveInputReason("Call me at 202-555-0147")).toBe("sensitive_content");
    expect(sensitiveInputReason("Card 1111 1111 1111 1111")).toBe("sensitive_content");
    expect(sensitiveWorkspaceContentReason("src/game/dialogue.json", '{"hint":"Call me at 202-555-0147"}')).toBe("sensitive_content");
  });

  it("ignores long hex hashes in workspace metadata but still blocks real phone numbers next to them", () => {
    const marker = JSON.stringify({
      schemaVersion: 1,
      templateId: "phaser-3.90.0-v1",
      manifestSha256: "0877bb057621d074039bfa0c026377bf2692249147240134f3188f187e070db1",
      status: "ready",
    });
    expect(sensitiveWorkspaceContentReason(".meta-game-template.json", marker)).toBeUndefined();
    expect(sensitiveWorkspaceContentReason(".meta-game-template.json", marker + " Call 202-555-0147")).toBe("sensitive_content");
  });

  it("ignores only version digits in npm tarball filenames", () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/@esbuild/linux-x64": {
          resolved: "https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.24.0.tgz",
        },
      },
    });
    expect(sensitiveWorkspaceContentReason("package-lock.json", lockfile)).toBeUndefined();
    const withPhone = JSON.stringify({ lockfileVersion: 3, packages: {}, description: "Call 202-555-0147" });
    expect(sensitiveWorkspaceContentReason("package-lock.json", withPhone)).toBe("sensitive_content");
  });

  it("ignores only SVG coordinate attributes and still scans visible text and credentials", () => {
    const geometry = '<svg viewBox="0 0 64 64"><path d="M 415 555 0147 32 8"/><polyline points="12,24 28,40"/></svg>';
    expect(sensitiveWorkspaceContentReason("public/assets/player.svg", geometry)).toBeUndefined();
    expect(sensitiveWorkspaceContentReason("public/assets/player.svg", geometry.replace("</svg>", "<text>Call 202-555-0147</text></svg>"))).toBe("sensitive_content");
    expect(sensitiveWorkspaceContentReason("public/assets/player.svg", geometry.replace("</svg>", "<text>Card 1111 1111 1111 1111</text></svg>"))).toBe("sensitive_content");
    expect(sensitiveWorkspaceContentReason("public/assets/player.svg", geometry.replace("</svg>", "<text>password=sample-placeholder-value</text></svg>"))).toBe("sensitive_content");
  });

  it("accepts the checked-in Phaser package lock and original SVG assets", () => {
    const root = resolve(process.cwd(), "packages/game-templates/phaser");
    const files = ["package-lock.json", ...readdirSync(resolve(root, "public/assets")).filter((name) => name.endsWith(".svg")).map((name) => `public/assets/${name}`)];
    for (const path of files) {
      expect(sensitiveWorkspaceContentReason(path, readFileSync(resolve(root, path), "utf8"))).toBeUndefined();
    }
  });
});
