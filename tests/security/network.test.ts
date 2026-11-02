import { describe, expect, it } from "vitest";
import { parseSandboxEnvironment } from "@meta-game/config";
import { validPathname, validPublicIpv4, validatePreviewRequest, validateRedirectLocation, validateRegistryRequest } from "../../infra/sandbox/egress-proxy.mjs";

describe("sandbox egress policy", () => {
  it("allows only public IPv4 upstreams and blocks private, reserved and IPv6 destinations", () => {
    expect(validPublicIpv4("104.16.24.34")).toBe(true);
    for (const address of [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
      "192.168.1.1", "192.0.2.1", "198.18.0.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "::ffff:127.0.0.1",
    ]) expect(validPublicIpv4(address)).toBe(false);
  });

  it("accepts read-only npm metadata and tarballs only on the configured registry host", () => {
    const hosts = new Set(["registry.npmjs.org"]);
    expect(validateRegistryRequest("/registry/registry.npmjs.org/phaser", hosts)).toEqual({
      hostname: "registry.npmjs.org", upstreamPath: "/phaser", tarball: false,
    });
    const tarballPath = Buffer.from("/phaser/-/phaser-3.90.0.tgz").toString("base64url");
    expect(validateRegistryRequest(`/registry/registry.npmjs.org/_tarball/${tarballPath}`, hosts)).toMatchObject({
      hostname: "registry.npmjs.org", upstreamPath: "/phaser/-/phaser-3.90.0.tgz", tarball: true,
    });
    expect(validateRegistryRequest("/registry/127.0.0.1/latest", hosts)).toBeNull();
    expect(validateRegistryRequest("/registry/registry.npmjs.org/%2e%2e/private", hosts)).toBeNull();
    expect(validateRegistryRequest("/registry/registry.npmjs.org/phaser?token=secret", hosts)).toBeNull();
    expect(validateRedirectLocation("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz", "registry.npmjs.org", hosts)).toMatchObject({
      hostname: "registry.npmjs.org", pathname: "/pkg/-/pkg-1.0.0.tgz",
    });
    expect(validateRedirectLocation("http://registry.npmjs.org/pkg.tgz", "registry.npmjs.org", hosts)).toBeNull();
    expect(validateRedirectLocation("https://169.254.169.254/latest/meta-data", "registry.npmjs.org", hosts)).toBeNull();
    expect(validateRedirectLocation("https://evil.example/pkg.tgz", "registry.npmjs.org", hosts)).toBeNull();
    expect(validateRedirectLocation("https://user:secret@registry.npmjs.org/pkg.tgz", "registry.npmjs.org", hosts)).toBeNull();
  });

  it("routes preview only to its fixed sandbox and rejects hostile hosts or traversal", () => {
    const expectedHost = "mg-egress-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:8080";
    expect(validatePreviewRequest("/__preview/@vite/client?session=1", expectedHost, expectedHost)).toEqual({
      gamePath: "/@vite/client", query: "?session=1",
    });
    expect(validatePreviewRequest("/__preview/%2e%2e/private", expectedHost, expectedHost)).toBeNull();
    expect(validatePreviewRequest("/__preview/%2fetc/passwd", expectedHost, expectedHost)).toBeNull();
    expect(validatePreviewRequest("/__preview/", "attacker:8080", expectedHost)).toBeNull();
    expect(validatePreviewRequest("http://169.254.169.254/latest", expectedHost, expectedHost)).toBeNull();
  });

  it("rejects redirects or dependency allowlists that name private networks", () => {
    expect(validPathname("/phaser/-/phaser-3.90.0.tgz")).toBe(true);
    expect(validPathname("/x/%2e%2e/private")).toBe(false);
    expect(() => parseSandboxEnvironment({
      SANDBOX_DRIVER: "rootless",
      SANDBOX_IMAGE: `registry.example.test/sandbox@sha256:${"a".repeat(64)}`,
      SANDBOX_CONTROLLER_TOKEN: "test-controller-token-1234567890abcdef",
      SANDBOX_EGRESS_ALLOWLIST: "registry.npmjs.org,169.254.169.254",
    })).toThrow("Invalid sandbox environment fields");
    expect(() => parseSandboxEnvironment({
      SANDBOX_DRIVER: "rootless",
      SANDBOX_IMAGE: `registry.example.test/sandbox@sha256:${"a".repeat(64)}`,
      SANDBOX_CONTROLLER_TOKEN: "test-controller-token-1234567890abcdef",
      SANDBOX_EGRESS_ALLOWLIST: "registry.npmjs.org,metadata.internal",
    })).toThrow("Invalid sandbox environment fields");
  });
});
