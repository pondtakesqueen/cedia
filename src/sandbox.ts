import { existsSync } from "node:fs";
import { platform } from "node:os";

export interface SandboxConfig {
  enabled: boolean;
  allowedDomains: string[];
  allowNetwork: boolean;
}

export function defaultSandboxConfig(): SandboxConfig {
  return {
    enabled: process.env.CEDIA_SANDBOX === "1" && platform() === "darwin" && existsSync("/usr/bin/sandbox-exec"),
    allowedDomains: [],
    allowNetwork: false,
  };
}
export function sandboxProfile(cwd: string, config: SandboxConfig): string {
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    // Allow process execution
    "(allow process-exec*)",
    "(allow process-fork)",
    // Allow signal handling
    "(allow signal (target self))",
    // Allow read everywhere (simplistic; tighten later)
    "(allow file-read*)",
    // Allow /dev/null
    '(allow file-read* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/null"))',
    // Allow write to cwd and tmp
    `(allow file-write* (subpath "${cwd}"))`,
    '(allow file-write* (subpath "/tmp"))',
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/var/folders"))',
    // Allow network if configured
  ];
  if (config.allowNetwork) {
    lines.push("(allow network*)");
  } else if (config.allowedDomains.length > 0) {
    for (const domain of config.allowedDomains) {
      lines.push(`(allow network-outbound (remote ip "${domain}:*"))`);
    }
  }
  // Allow mach/IPC for process coordination
  lines.push("(allow mach-lookup)");
  lines.push("(allow ipc-posix-shm*)");
  lines.push("(allow sysctl-read)");
  return lines.join("\n");
}

export function wrapCommand(command: string, cwd: string, config: SandboxConfig): string {
  if (!config.enabled) return command;
  const profile = sandboxProfile(cwd, config);
  // Write profile to a temp file and use sandbox-exec
  const { writeFileSync, mkdtempSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const dir = mkdtempSync(join(tmpdir(), "cedia-sb-"));
  const profilePath = join(dir, "profile.sb");
  writeFileSync(profilePath, profile);
  return `/usr/bin/sandbox-exec -f ${profilePath} bash -c ${JSON.stringify(command)}`;
}