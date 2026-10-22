// A profile is a named set of defaults for a run, picked with --profile: the model, the permission, which of the
// optional tools the writer gets, and instructions that say what role the session plays. A flag still wins over
// the profile, and the profile over settings. A thread opened with a profile keeps it: `--thread` goes on with the
// thread's profile unless another is named.
//
// cedia ships one, `coordinator`, for the desktop's project chat: a read-only session that talks with the owner,
// splits the work into threads with open_thread, follows them, and does none of the work itself. A profile of the
// same name in the user's settings (`profiles` in ~/.cedia/settings.json) is laid over cedia's, key by key.

export type Profile = {
  model?: string;
  permission?: 'read-only' | 'workspace';
  spawn?: 'on' | 'off' | 'worktree';
  ask?: boolean;
  todo?: boolean;
  // open_thread (core/tools/open.ts): the session may open threads of the project for others to run.
  openThread?: boolean;
  instructions?: string;
};

const KEYS: (keyof Profile)[] = ['model', 'permission', 'spawn', 'ask', 'todo', 'openThread', 'instructions'];

export const COORDINATOR_INSTRUCTIONS = `You are this project's coordinator. The owner talks with you in the project chat; the work itself happens in threads, each a session of its own in a worktree of its own, which you open and follow.

- When the owner asks for work, split it into pieces that can run on their own, and open one thread per piece with open_thread: a complete brief (the goal, the facts and paths it needs, what done looks like, and what to report), since the thread sees only that. Do not open a thread for a question you can answer yourself by reading.
- You do not edit files or run the work yourself: you read, plan, open threads and report. A thread's progress is its todo list; read_thread shows what it did, and message_thread tells it something or answers it.
- Keep your own todo list of the threads you opened and what each is for, so the owner sees the plan.
- Answer the owner briefly: what you opened and why, what is done, what needs them. Ask them (ask_user) only for a decision that changes the goal; a thread that asks you something, answer yourself when you can.`;

export const BUILTIN_PROFILES: Record<string, Profile> = {
  coordinator: { permission: 'read-only', spawn: 'on', ask: true, todo: true, openThread: true, instructions: COORDINATOR_INSTRUCTIONS },
};

// The profile `name`, cedia's own with the user's laid over it. An unknown name or a bad field is an error.
export function resolveProfile(name: string, user: Record<string, unknown> = {}): Profile {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error(`a profile name is 1 to 32 letters, digits, _ or -: ${name}`);
  const raw = user[name];
  if (raw === undefined && !BUILTIN_PROFILES[name]) throw new Error(`no profile "${name}" (known: ${[...new Set([...Object.keys(BUILTIN_PROFILES), ...Object.keys(user)])].join(', ')})`);
  return { ...BUILTIN_PROFILES[name], ...(raw === undefined ? {} : checkProfile(name, raw)) };
}

function checkProfile(name: string, raw: unknown): Profile {
  const at = `profiles.${name}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${at} must be an object`);
  const p = raw as Record<string, unknown>;
  const unknown = Object.keys(p).find((k) => !KEYS.includes(k as keyof Profile));
  if (unknown) throw new Error(`unknown setting "${at}.${unknown}" (known: ${KEYS.join(', ')})`);
  if (p.model !== undefined && (typeof p.model !== 'string' || !p.model)) throw new Error(`${at}.model must be a model alias or ref`);
  if (p.permission !== undefined && p.permission !== 'read-only' && p.permission !== 'workspace') throw new Error(`${at}.permission must be read-only or workspace`);
  if (p.spawn !== undefined && p.spawn !== 'on' && p.spawn !== 'off' && p.spawn !== 'worktree') throw new Error(`${at}.spawn must be on, off or worktree`);
  for (const k of ['ask', 'todo', 'openThread'] as const) if (p[k] !== undefined && typeof p[k] !== 'boolean') throw new Error(`${at}.${k} must be true or false`);
  if (p.instructions !== undefined && typeof p.instructions !== 'string') throw new Error(`${at}.instructions must be the text of the instructions`);
  return p as Profile;
}

// The run's flags with the profile's defaults under them: a flag the user gave wins.
export function withProfile<A extends { model?: string; permission?: string; spawn?: string; ask?: string; todo?: string }>(args: A, p: Profile): A {
  const on = (v: boolean | undefined) => (v === undefined ? undefined : v ? 'on' : 'off');
  const fill = { model: p.model, permission: p.permission, spawn: p.spawn, ask: on(p.ask), todo: on(p.todo) };
  const out = { ...args };
  for (const [k, v] of Object.entries(fill)) if (v !== undefined && out[k as keyof A] === undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
