import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PatchHunk {
  context: string[];
  removed: string[];
  added: string[];
}

export interface PatchFile {
  path: string;
  action: "update" | "add" | "delete";
  hunks: PatchHunk[];
}

export interface PatchResult {
  ok: boolean;
  error?: string;
  applied: string[];
}

function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  const lines = patch.split("\n");
  let i = 0;
  let current: PatchFile | null = null;
  let currentHunk: PatchHunk | null = null;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("*** Update File:")) {
      if (current) files.push(current);
      current = { path: line.slice("*** Update File:".length).trim(), action: "update", hunks: [] };
      currentHunk = null;
      i++;
      continue;
    }
    if (line.startsWith("*** Add File:")) {
      if (current) files.push(current);
      current = { path: line.slice("*** Add File:".length).trim(), action: "add", hunks: [] };
      currentHunk = null;
      i++;
      continue;
    }
    if (line.startsWith("*** Delete File:")) {
      if (current) files.push(current);
      current = { path: line.slice("*** Delete File:".length).trim(), action: "delete", hunks: [] };
      currentHunk = null;
      i++;
      continue;
    }
    if (line.startsWith("*** End Patch") || line.startsWith("*** Begin Patch")) {
      i++;
      continue;
    }
    if (!current) {
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      currentHunk = { context: [], removed: [], added: [] };
      current.hunks.push(currentHunk);
      i++;
      continue;
    }
    if (!currentHunk) {
      currentHunk = { context: [], removed: [], added: [] };
      current.hunks.push(currentHunk);
    }
    if (line.startsWith("+")) {
      currentHunk.added.push(line.slice(1));
    } else if (line.startsWith("-")) {
      currentHunk.removed.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      currentHunk.context.push(line.slice(1));
    } else if (line === "") {
      // blank line in context
      currentHunk.context.push("");
    }
    i++;
  }
  if (current) files.push(current);
  return files;
}

export function applyPatch(patch: string, cwd: string): PatchResult {
  const files = parsePatch(patch);
  const applied: string[] = [];
  for (const file of files) {
    const fullPath = file.path.startsWith("/") ? file.path : join(cwd, file.path);
    try {
      if (file.action === "delete") {
        if (existsSync(fullPath)) unlinkSync(fullPath);
        applied.push(`deleted: ${file.path}`);
        continue;
      }
      if (file.action === "add") {
        const content = file.hunks.flatMap((h) => h.added).join("\n");
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content + (content.endsWith("\n") ? "" : "\n"));
        applied.push(`added: ${file.path}`);
        continue;
      }
      // update
      if (!existsSync(fullPath)) {
        return { ok: false, error: `file not found: ${file.path}`, applied };
      }
      const original = readFileSync(fullPath, "utf8").split("\n");
      const result = [...original];
      for (const hunk of file.hunks) {
        // Find the hunk location by matching context
        const searchLines = [...hunk.context, ...hunk.removed];
        let found = -1;
        for (let i = 0; i <= result.length - searchLines.length; i++) {
          let match = true;
          for (let j = 0; j < searchLines.length; j++) {
            if (result[i + j] !== searchLines[j]) { match = false; break; }
          }
          if (match) { found = i; break; }
        }
        if (found === -1) {
          return { ok: false, error: `could not find hunk context in ${file.path}`, applied };
        }
        // Apply: replace removed with added
        const removeCount = hunk.removed.length;
        const addLines = hunk.added;
        result.splice(found + hunk.context.length, removeCount, ...addLines);
      }
      writeFileSync(fullPath, result.join("\n"));
      applied.push(`updated: ${file.path}`);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), applied };
    }
  }
  return { ok: true, applied };
}