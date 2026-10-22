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
  | 'todo' // --todo: the todo tool and the 'todo' thread event, a thread's progress
  | 'profiles' // --profile, profiles in settings, the profile in a thread's open event
  | 'open_thread' // the coordinator profile's open_thread: threads opened 'queued' with `by`, for a client to run
  | 'schedules'; // cedia schedules, the schedule tool for profiles with schedule, Schedule and ScheduleEvent

export type VersionInfo = { name: 'cedia'; version: string; protocol: string; capabilities: Capability[] };

// Bun gives the text of a file imported with type "text"; TypeScript still types it as the parsed JSON.
export const PROTOCOL = hash(schemaText as unknown as string);

export function versionInfo(): VersionInfo {
  const capabilities: Capability[] = ['stream-json', 'threads', 'threads.send', 'threads.unsend', 'threads.rate', 'evidence.check-thread', 'spawn', 'handoff', 'plan', 'review', 'ask', 'todo', 'profiles', 'open_thread', 'schedules'];
  if (processKeychain()) capabilities.push('keychain');
  return { name: 'cedia', version: VERSION, protocol: PROTOCOL, capabilities };
}
