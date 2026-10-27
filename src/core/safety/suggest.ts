// `cedia permissions suggest`: read past session logs for calls the policy stopped, and propose the
// allow rules that would have let the safe ones through — fewer prompts without opening anything risky.
// Only two shapes are ever proposed: read-only bash commands as `bash(<command> *)`, and MCP tools by
// their exact `mcp__server__tool` name. Edits, writes and mutating commands stay per-decision; anything a
// deny rule (or a built-in guard) stopped is skipped, since deny always wins. Suggestions go to the USER
// settings: a repository's settings can only tighten, never grant.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSettings } from '../config.ts';
import type { SessionInput } from '../session/usage.ts';
import { rulePatternMatches } from '../safety/policy.ts';
import { checkReadOnly } from '../tools/bash.ts';
import { simpleCommands } from '../safety/shell.ts';
import type { JsonObject } from '../types.ts';

export type Suggestion = { rule: string; hits: number; example: string; tool: string };
export type SuggestResult = { suggestions: Suggestion[]; skippedDeny: number; skippedUnsafe: number; sessions: number };

const TOP = 10;

// The policy's own reason for stopping the call, from its permission event: only `mode:read-only` (nothing
// pre-approved it) is suggestible. A deny rule, a guard, or a redacted secret stays stopped.
const SUGGESTIBLE = 'mode:read-only';

export function suggestAllowRules(sessions: SessionInput[], opts: { allow: string[]; deny: string[]; top?: number }): SuggestResult {
  const top = opts.top ?? TOP;
  const hits = new Map<string, { hits: number; example: string; tool: string }>();
  let skippedDeny = 0;
  let skippedUnsafe = 0;
  for (const s of sessions) {
    const use = new Map<string, { name: string; input: JsonObject }>();
    const reason = new Map<string, string>();
    for (const e of s.events) {
      if (e.kind === 'assistant') {
        for (const b of e.blocks) if (b.type === 'tool_use') use.set(b.callId ?? b.id, { name: b.name, input: b.input });
      } else if (e.kind === 'permission' && e.decision === 'deny') {
        reason.set(e.callId, e.rule);
      }
    }
    for (const e of s.events) {
      if (e.kind !== 'tool_result' || e.status !== 'denied') continue;
      const call = use.get(e.callId);
      if (!call) continue;
      if ((reason.get(e.callId) ?? '') !== SUGGESTIBLE) {
        skippedDeny++;
        continue;
      }
      const candidate = call.name === 'bash' ? bashRule(String((call.input as { command?: unknown }).command ?? '')) : mcpRule(call.name);
      if (!candidate) {
        skippedUnsafe++;
        continue;
      }
      // Already covered, or held by a deny rule (which an allow could never lift): not proposed.
      if (opts.allow.includes(candidate.rule)) continue;
      if (opts.deny.some((d) => rulePatternMatches(d, call.name, candidate.text))) {
        skippedDeny++;
        continue;
      }
      const hit = hits.get(candidate.rule) ?? { hits: 0, example: candidate.text.slice(0, 120), tool: call.name };
      hit.hits++;
      hits.set(candidate.rule, hit);
    }
  }
  return { suggestions: [...hits].map(([rule, h]) => ({ rule, ...h })).sort((a, b) => b.hits - a.hits).slice(0, top), skippedDeny, skippedUnsafe, sessions: sessions.length };
}

// A read-only bash line with one simple command becomes `bash(<command> *)` over its text. Anything else —
// a mutating command, several commands in one line (an allow rule matches every part, so per-part rules
// would over-allow), or a line that cannot be read — is never proposed.
function bashRule(command: string): { rule: string; text: string } | undefined {
  if (!checkReadOnly(command).ok) return undefined;
  const commands = simpleCommands(command);
  const first = commands?.length === 1 ? commands[0]?.[0] : undefined;
  if (!first || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(first)) return undefined;
  return { rule: `bash(${first} *)`, text: command };
}

// MCP tools are proposed by exact name: cedia cannot know what one does, so no wildcard may cover a new one.
function mcpRule(name: string): { rule: string; text: string } | undefined {
  return /^mcp__[\w-]+__[\w-]+$/.test(name) ? { rule: name, text: name } : undefined;
}

// Append missing rules to the USER settings' allow list (whole-file rewrite through a temp file).
// Throws when the file on disk fails validation, rather than writing past it.
export function applyAllowRules(home: string, rules: string[]): { added: string[] } {
  const path = join(home, 'settings.json');
  let raw: Record<string, unknown>;
  try {
    raw = (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
  const checked = checkSettings(raw);
  const have = new Set((checked.permissions?.allow ?? []).map(String));
  const added = rules.filter((r) => !have.has(r));
  if (!added.length) return { added: [] };
  mkdirSync(home, { recursive: true });
  const next = { ...raw, permissions: { ...((raw.permissions ?? {}) as Record<string, unknown>), allow: [...(checked.permissions?.allow ?? []), ...added] } };
  checkSettings(next);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, path);
  return { added };
}
