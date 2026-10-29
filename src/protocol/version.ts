// `cedia --version --json`: what a client checks before it runs cedia. `protocol` is the first 16 hex digits of
// the sha256 of protocol.schema.json as this build has it, so a client that pinned the schema can tell whether
// the shapes it was built on are the ones this cedia speaks. `capabilities` names the features a client may
// branch on; one is added when a feature lands and never renamed.
import schemaText from './protocol.schema.json' with { type: 'text' };
import { hash } from '../core/hash.ts';
import { processKeychain } from '../core/providers/keychain.ts';
import { VERSION } from '../core/version.ts';

export type Capability =
  | 'stream-json' // -p --output-format stream-json: CoreMessage lines
  | 'threads' // --thread, cedia threads list|show|archive|unarchive
  | 'threads.send' // cedia threads send, printing the message id
  | 'threads.unsend' // cedia threads unsend
  | 'threads.rate' // cedia threads rate
  | 'evidence.check-thread' // each evidence check names the thread that ran it
  | 'keychain' // API keys are read from the macOS Keychain after the environment (only where there is one)
  | 'spawn' // sub-threads
  | 'handoff' // a long session hands off to a new session of its thread
  | 'plan' // --plan
  | 'review' // --review
  | 'ask' // --ask: ask_user, the 'asked' result, the 'question' thread event and the 'asking' state
  | 'worktree.newest-wins' // a worktree's merge back takes lockfiles and generated files whole from the side written last
  | 'spawn.best-of-n' // spawn{approaches}: several work sub-threads try a task, and the one that passes most checks is kept
  | 'todo' // --todo: the todo tool and the 'todo' thread event, a thread's progress
  | 'profiles' // --profile, profiles in settings, the profile in a thread's open event
  | 'open_thread' // the coordinator profile's open_thread: threads opened 'queued' with `by`, for a client to run
  | 'schedules' // cedia schedules, the schedule tool for profiles with schedule, Schedule and ScheduleEvent
  | 'models' // cedia models --json: ModelList, the models a picker may offer and which have a key here
  | 'permissions' // cedia permissions --json (PermissionList), --permission plan, and `permission` on each run event
  | 'commands' // cedia commands --json (CommandList), and a prompt starting /<skill> loads that skill
  | 'threads.fork' // cedia threads fork <id> <n|run>: edit and resend; the new thread's open event has forkOf
  | 'threads.side' // cedia threads fork <id> end --side: a side chat, forked at the thread's end; its open event has side
  | 'usage' // cedia usage --json (UsageReport) with the cost by day, model, project and thread, --since and --all
  | 'browser' // --browser <endpoint>: the browser tool on a Chromium the client started, by its DevTools endpoint
  | 'threads.restore-json' // cedia threads undo|redo <id> --json (Restored) and rewind <id> <n> --json (RewindResult)
  | 'images' // -p --image <file>: images shown to the writer with the prompt, and read opens image files
  | 'cache-ttl' // --cache-ttl 5m|1h: how long the writer's cached prompt lasts on the Anthropic wire
  | 'threads.rename' // cedia threads rename <id> <title>: a 'title' thread event, the latest one the thread's title
  | 'threads.delete' // cedia threads delete <id> [--force] [--json] (DeleteResult): the thread, its sub-threads and their logs
  | 'mcp.manage' // cedia mcp list|check --json (McpList, McpCheck), add and remove: the user's MCP servers
  | 'commit' // cedia commit --thread <id> [--message <m> [--file <f>]...] --json (CommitDraft, Committed): the thread's files
  | 'pr' // cedia pr [--check] --json (PrPlan, PrOpened): push the branch and open its pull request through gh
  | 'daemon' // cedia daemon [--once]: run queued threads and due schedules in cedia processes of their own
  | 'daemon.desktop-lock' // cedia daemon yields to the desktop's daemon while it holds ~/.cedia/desktop.lock (DesktopLock)
  | 'threads.send-images' // cedia threads send --image <file>; -p --image sha256:<hex>; a fork's ForkResult names the run's images
  | 'video' // --image and threads send --image take a video (needs ffmpeg) as its frames; read opens video files
  | 'media-route' // -p with images on a text-only code model runs on --media (default Haiku 5.5)
  | 'code-review' // cedia review --thread <id> --json (CodeReview): a read-only review of the thread's files, findings by file and line
  | 'complete' // cedia complete --file --at <line:col> [--stdin] --json (Completion): the text tab completion offers at the cursor
  | 'inline-edit'; // cedia inline-edit --file --range --instruction [--stdin] --json (InlineEdit): a selection's new text and patch

export type VersionInfo = { name: 'cedia'; version: string; protocol: string; capabilities: Capability[] };

// Bun gives the text of a file imported with type "text"; TypeScript still types it as the parsed JSON.
export const PROTOCOL = hash(schemaText as unknown as string);

export function versionInfo(): VersionInfo {
  const capabilities: Capability[] = ['stream-json', 'threads', 'threads.send', 'threads.unsend', 'threads.rate', 'evidence.check-thread', 'spawn', 'handoff', 'plan', 'review', 'ask', 'todo', 'profiles', 'open_thread', 'schedules', 'worktree.newest-wins', 'spawn.best-of-n', 'models', 'permissions', 'commands', 'threads.fork', 'usage', 'threads.restore-json', 'images', 'browser', 'cache-ttl', 'threads.rename', 'threads.delete', 'mcp.manage', 'commit', 'pr', 'threads.side', 'daemon', 'daemon.desktop-lock', 'threads.send-images', 'inline-edit', 'video', 'media-route', 'code-review', 'complete'];
  if (processKeychain()) capabilities.push('keychain');
  return { name: 'cedia', version: VERSION, protocol: PROTOCOL, capabilities };
}
