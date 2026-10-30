// JSONL protocol between the core and clients. Core -> client: every session event, the stream
// events of the current attempt, and one result. Client -> core: commands.
import type { HeadlessResult, SessionEvent, StreamEvent } from '../core/types.ts';

// Clients that read cedia's files (the desktop indexes threads and replays sessions) take these shapes from here.
// `protocol.schema.json` beside this file is generated from them (`bun scripts/protocol-schema.ts`); a test fails
// when it is stale.
export type { SessionEvent } from '../core/types.ts';
export type { ThreadEvent } from '../core/project/threads.ts';
export type { Schedule, ScheduleEvent } from '../core/project/schedules.ts';
export type { ModelEntry, ModelList } from '../core/providers/models.ts';
export type { UsageReport } from '../core/session/usage.ts';
export type { ContextBreakdown, ContextPart } from '../core/context/breakdown.ts';
export type { AwayRecap, RecapRun } from '../core/project/recap.ts';
export type { ThreadSearch, ThreadSearchHit, ThreadSearchMatch } from '../core/project/search.ts';
export type { PermissionEntry, PermissionList } from '../core/safety/policy.ts';
export type { CommandEntry, CommandList } from '../core/skills/skills.ts';
export type { Restored } from '../core/project/undo.ts';
export type { RewindResult } from '../core/project/rewind.ts';
export type { DeleteResult } from '../core/project/delete.ts';
export type { ForkResult } from '../core/project/fork.ts';
export type { McpCheck, McpList } from '../core/mcp/manage.ts';
export type { CommitDraft, Committed, PrOpened, PrPlan } from '../core/project/commit.ts';
export type { CodeFinding, CodeReview } from '../core/project/code-review.ts';
export type { Completion } from '../core/project/complete.ts';
export type { InlineEdit, InlineEditPosition, InlineEditRange } from '../core/project/inline-edit.ts';
export type { DesktopLock } from '../core/project/desktop-lock.ts';
export type { Capability, VersionInfo } from './version.ts';

export type CoreMessage = { type: 'event'; event: SessionEvent } | { type: 'stream'; event: StreamEvent } | HeadlessResult;

export type Command =
  | { type: 'prompt'; text: string }
  | { type: 'abort' }
  | { type: 'resume'; sessionId: string }
  | { type: 'fork'; sessionId: string; at: string };

export const encode = (m: CoreMessage | Command): string => JSON.stringify(m) + '\n';

export function decode<T extends CoreMessage | Command>(line: string): T {
  return JSON.parse(line) as T;
}
