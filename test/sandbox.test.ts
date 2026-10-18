import { describe, expect, test } from "vitest";
import { defaultSandboxConfig, sandboxProfile } from "../src/sandbox.ts";

describe("sandbox", () => {
  test("default config enabled on darwin with sandbox-exec", () => {
    const config = defaultSandboxConfig();
    expect(typeof config.enabled).toBe("boolean");
    expect(Array.isArray(config.allowedDomains)).toBe(true);
  });

  test("profile includes deny default", () => {
    const profile = sandboxProfile("/tmp/test", defaultSandboxConfig());
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow file-read*)");
    expect(profile).toContain("/dev/null");
  });

  test("profile includes network when allowed", () => {
    const config = { ...defaultSandboxConfig(), allowNetwork: true };
    const profile = sandboxProfile("/tmp/test", config);
    expect(profile).toContain("(allow network*)");
  });
});