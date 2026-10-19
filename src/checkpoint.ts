import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function checkpointDir(sessionId: string): string {
  return join(homedir(), ".cedia", "checkpoints", sessionId);
}

export function initCheckpoint(cwd: string, sessionId: string): string {
  const dir = checkpointDir(sessionId);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(`${dir}/.git`)) {
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync('git config user.email "cedia@localhost"', { cwd: dir, stdio: "ignore" });
    execSync('git config user.name "cedia"', { cwd: dir, stdio: "ignore" });
  }
  // Sync working tree into shadow repo
  execSync(`rsync -a --checksum --exclude=.git "${cwd}/" "${dir}/"`, { stdio: "ignore" });
  execSync("git add -A", { cwd: dir, stdio: "ignore" });
  try {
    execSync('git commit -m "initial"', { cwd: dir, stdio: "ignore" });
  } catch {
    // nothing to commit
  }
  return dir;
}
export function createCheckpoint(dir: string, cwd: string, message: string): boolean {
  try {
    execSync(`rsync -a --checksum --exclude=.git "${cwd}/" "${dir}/"`, { stdio: "ignore" });
    execSync("git add -A", { cwd: dir, stdio: "ignore" });
    execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function undoCheckpoint(dir: string, cwd: string): boolean {
  try {
    execSync("git reset --hard HEAD~1", { cwd: dir, stdio: "ignore" });
    execSync(`rsync -a --checksum --exclude=.git --delete "${dir}/" "${cwd}/"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function checkpointCount(dir: string): number {
  try {
    const out = execSync("git rev-list --count HEAD", { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}
export function listCheckpoints(dir: string): string[] {
  try {
    const out = execSync("git log --format=%H:::%s", { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function forkCheckpoint(dir: string, commit: string, newSessionId: string): string | undefined {
  try {
    const target = join(homedir(), ".cedia", "checkpoints", newSessionId);
    mkdirSync(target, { recursive: true });
    if (!existsSync(`${target}/.git`)) {
      execSync("git init", { cwd: target, stdio: "ignore" });
      execSync('git config user.email "cedia@localhost"', { cwd: target, stdio: "ignore" });
      execSync('git config user.name "cedia"', { cwd: target, stdio: "ignore" });
    }
    const hash = execFileSync("git", ["rev-parse", commit], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    execSync(`git fetch "${dir}" ${hash}`, { cwd: target, stdio: "ignore" });
    execSync("git checkout -f FETCH_HEAD", { cwd: target, stdio: "ignore" });
    return target;
  } catch {
    return undefined;
  }
}
