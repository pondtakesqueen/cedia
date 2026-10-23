import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runHeadless } from './clients/headless/main.ts';
import type { TuiArgs } from './clients/tui/main.ts';
import { ALIASES } from './core/providers/catalog.ts';
import { GUARDS, PERMISSION_ENTRIES, type PermissionList } from './core/safety/policy.ts';
import { cediaHome, loadPermissionSetting, loadRoles } from './core/config.ts';
import { processKeychain } from './core/providers/keychain.ts';
import { modelLine, modelList } from './core/providers/models.ts';
import { threadLine, threadsDir, ThreadStore, type Rating } from './core/project/threads.ts';
import { memoryPath, MemoryStore } from './core/project/memory.ts';
import { minutesOf, scheduleLine, ScheduleStore, schedulesPath, whenOf, type Schedule } from './core/project/schedules.ts';
import { commandList, loadSkills } from './core/skills/skills.ts';
import { restoredText, restoreTurn, sinceTurn, threadTurn } from './core/project/undo.ts';
import { rewindThread, rewoundText, runLines, type RewindResult } from './core/project/rewind.ts';
import { forkThread } from './core/project/fork.ts';
import { workspaceSnapshots } from './core/safety/snapshot.ts';
import { lintSession } from './core/session/lint.ts';
import { projectKey, sessionPath, SessionLog } from './core/session/log.ts';
import { formatUsage, isUsageEvent, readEventsLenient, sinceOf, usageReport, type SessionInput } from './core/session/usage.ts';
import { EFFORTS, type Effort } from './core/types.ts';
import { versionInfo } from './protocol/version.ts';

const USAGE = `usage: cedia [options]                 the TUI, at a terminal: each prompt is a turn of one thread
       cedia -p "<prompt>" [options]   (prompt may also come on stdin)
       cedia --version [--json]             the version; --json adds the protocol hash and capabilities

  -m, --model <ref>            the code role: model alias or ref (default: $CEDIA_MODEL, roles.code in settings, deepseek)
      --plan <ref>             the plan role: a model, claude-code[:<model>] to plan in your own Claude Code
                               (default opus there), or none (default: roles.plan in settings, none)
      --output-format <f>      text | json | stream-json (default text)
      --max-turns <n>          stop after n model calls (default 200)
      --max-budget-usd <x>     stop once spend reaches x
      --effort <level>         low | medium | high | xhigh | max (default: the model's, see catalog)
      --escalate <level|off>   the effort a writer session moves to, once, when the done gate refuses its claim
                               (default high). Claude 5.5 models only: the change is a message, so the cache stays
      --cwd <dir>              working directory (default: current)
      --permission <mode>      auto | read-only | plan | workspace (default: $CEDIA_PERMISSION, ~/.cedia/settings.json, auto).
                               auto is workspace when the sandbox is on, read-only when it is off; plan is read-only and
                               ends with a plan and the question whether to go ahead. cedia never stops to ask for permission
      --allow <rule>           allow a call, e.g. 'bash(bun test*)' or 'edit(src/*)'; repeatable
      --deny <rule>            deny a call; repeatable. The built-in guards always apply unless unlocked
      --unlock <guard>         lift a built-in guard: ${GUARDS.join(', ')}; repeatable
      --privacy <level>        no-training | zdr: which models may see this repo (default: $CEDIA_PRIVACY, settings, no-training)
      --fallback <ref|none>    model to continue on in a new session when this one's quota runs out
                               (default: settings, then deepseek -> Haiku 5.5 on the Claude API)
      --on-quota <fallback|wait:<min>>  on a spent quota that says when it comes back, wait up to min minutes in all
                               before falling back (default: settings onQuota, fallback)
      --review <ref>           the review role, after the done gate passes: a model, claude-code[:<model>]
                               (default sonnet there), or none. Changes it asks for go back to the writer once
      --goal <condition>       keep going until a separate judge finds the condition holds: after each claim of done
                               it reads the change and answers met, not met (the writer goes on with what is
                               missing, at most 3 more times) or impossible. Exit 1 unless met
      --goal-judge <ref>       the judge's model (default: the writer's, in a fresh read-only session)
      --goal-mode <light|full> full: the judge's model first writes acceptance criteria that go with the task and that
                               the judge answers one by one, and a strategist proposes a change of approach when the
                               same criteria stay unmet two rounds in a row (default light)
      --advisor <ref|none>     the advisor role: a model that reads each of the writer's turns and may leave it a
                               note before the next (default: settings roles.advisor, none). One reply a turn
      --classifier <ref|none>  the classifier role: a model that reads each command no allow rule names before it
                               runs, and may block it (default: settings roles.classifier, none). One reply a command
      --spawn <on|off|worktree>
                               let the writer hand self-contained work to sub-threads (default: settings, on);
                               worktree runs each work sub-thread in a git worktree of its own, several at once
      --lsp <on|off>           after each edit, add the file's errors from a language server when one is installed
                               (typescript-language-server, pyright-langserver, gopls; more in settings "lsp"). Default on
      --ask <on|off>           give the writer ask_user, to end the run with one question for you when only you can
                               decide; the thread waits as 'asking' and your answer is its next prompt
                               (default: settings ask, off)
      --todo <on|off>          give the writer a todo list, kept in the thread as its progress (default: settings
                               todo, off)
      --browser <endpoint>     give the writer the browser tool on a Chromium you started, by its DevTools endpoint
                               (http://host:port, or ws://host:port/devtools/page/<id> for one page); it opens the
                               hosts web_fetch may reach and loopback, widened by allow rules browser(<domain>)
      --profile <name>         a named set of defaults under these flags: model, permission, tools, instructions
                               (settings profiles; built in: coordinator, which opens threads with open_thread).
                               A thread goes on with the profile it was opened with
      --swarm <ref>            the model explore sub-threads run on (default: roles.swarm in settings, beam)
      --workers <ref,...>      models besides the code model that a part of a split plan may run on; the planner
                               picks one per part by how hard it is (default: roles.workers in settings, none)
      --thread <id>            go on with a thread of this project instead of opening a new one
      --handoff-at <n|off>     hand off to a new session of the thread once the context reaches n tokens
                               (default: settings, then half the window, at most 150k)
      --handoff <note|compact> how a session hands off: the model writes a note, or the provider summarizes the
                               older turns and the newest are kept (Claude API models only; default: settings, note)
      --check <command>        declared check for the done gate, e.g. 'bun test'; repeatable
      --sandbox <s>            auto | on | off: OS sandbox for bash (default: $CEDIA_SANDBOX, settings, auto)
      --allow-domain <host>    let sandboxed commands reach this host; repeatable
      --no-session-file        keep the session log in memory only

       cedia lint-session <file.jsonl>...   check session logs against the trust invariants
       cedia usage [<file.jsonl>... | --thread <id> | --last <n> | --since <day|Nd>] [--all] [--json] [--cwd <dir>]
                                            where the spend went: input by source, the costliest tool results,
                                            cache misses by cause, and cost by day, model, project and thread
                                            (default: this project's last 20 sessions; --since: every session
                                            in the range; --all: every project)
       cedia threads [--all] [--cwd <dir>]  list this project's threads (--all: archived ones too)
       cedia threads show <id>              a thread's task, state, sessions, handoff note, result and messages
       cedia threads send <id> <text>       leave a message the thread sees at its next turn; prints the message id
       cedia threads unsend <id> [<msg>...] take back your messages it has not seen yet (all of them by default)
       cedia threads rate <id> <up|down> [--session <sid>] [--note <text>]
                                            rate an answer (default: the thread's latest) for picking eval cases;
                                            no model ever sees it
       cedia threads archive|unarchive <id> hide a thread from the list, or bring it back
       cedia threads diff <id>              what changed since the thread's last turn that changed files started
       cedia threads undo|redo <id> [--force] [--json]
                                            put the files that turn changed back (or forward again), from cedia's
                                            snapshots; a file changed since is left unless --force. Commands the turn
                                            ran are not undone. The thread is told at its next turn
       cedia threads rewind <id> [<n>] [--force] [--json]
                                            go back to just before the thread's run n (threads show numbers them),
                                            conversation and files together: the thread goes on from there, and
                                            every file a later run changed is put back. It refuses while the thread
                                            is working, or when such a file changed since (--force: anyway).
       cedia threads fork <id> <n|run> [--json]
                                            a new thread whose conversation is this one's just before run n (or the
                                            run with that id), for sending its message again, edited; the original
                                            thread and the files are left as they are
                                            Without n, lists the runs
       cedia schedules [list | due] [--json]
                                            the project's scheduled prompts, or the ones due now. Whoever runs
                                            threads (the desktop's daemon, cron) runs each due one with
                                            cedia -p <prompt> --thread <thread> after cedia schedules fire <id>
       cedia schedules add <when> <prompt> --thread <id> [--every <dur>]
                                            when: an ISO time or a delay (30m, 2h); every: 1h, 1d, 1w (at least 5m)
       cedia schedules cancel|pause|resume|fire <id>
       cedia memory [list | add <text> | forget <id>]
                                            the project's memory: short facts every new session gets in its first
                                            turn; writer sessions add to it with the remember tool
       cedia models [--json]                the models a session may use, which of them have a key here, and the
                                            one the code role takes now (marked *)
       cedia permissions [--json]           the permission modes a run may take (--permission) and the default
       cedia commands [--json] [--cwd <dir>]
                                            what a client offers for /: each skill here; a prompt that starts with
                                            /<skill> asks the writer to load it first
       cedia skills [--cwd <dir>]           the skills a session here can load: the user's (~/.cedia/skills) and the
                                            repository's (.agents/skills, .claude/skills, .cursor/skills)

models: ${Object.keys(ALIASES).join(', ')}`;

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === '--version' || argv[0] === '-v') {
    const info = versionInfo();
    console.log(argv.slice(1).includes('--json') ? JSON.stringify(info) : `cedia ${info.version}`);
    return 0;
  }
  if (argv[0] === 'lint-session') return lintFiles(argv.slice(1));
  if (argv[0] === 'threads') return threads(argv.slice(1));
  if (argv[0] === 'memory') return memory(argv.slice(1));
  if (argv[0] === 'schedules') return schedules(argv.slice(1));
  if (argv[0] === 'skills') return skills(argv.slice(1));
  if (argv[0] === 'commands') return commands(argv.slice(1));
  if (argv[0] === 'permissions') return permissions(argv.slice(1));
  if (argv[0] === 'models') return models(argv.slice(1));
  if (argv[0] === 'usage') return usage(argv.slice(1));
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      print: { type: 'string', short: 'p' },
      model: { type: 'string', short: 'm' },
      'output-format': { type: 'string', default: 'text' },
      'max-turns': { type: 'string' },
      'max-budget-usd': { type: 'string' },
      effort: { type: 'string' },
      escalate: { type: 'string' },
      cwd: { type: 'string' },
      permission: { type: 'string' },
      allow: { type: 'string', multiple: true },
      deny: { type: 'string', multiple: true },
      unlock: { type: 'string', multiple: true },
      privacy: { type: 'string' },
      fallback: { type: 'string' },
      'on-quota': { type: 'string' },
      thread: { type: 'string' },
      spawn: { type: 'string' },
      lsp: { type: 'string' },
      ask: { type: 'string' },
      todo: { type: 'string' },
      browser: { type: 'string' },
      profile: { type: 'string' },
      swarm: { type: 'string' },
      workers: { type: 'string' },
      'handoff-at': { type: 'string' },
      handoff: { type: 'string' },
      review: { type: 'string' },
      goal: { type: 'string' },
      'goal-judge': { type: 'string' },
      'goal-mode': { type: 'string' },
      advisor: { type: 'string' },
      classifier: { type: 'string' },
      plan: { type: 'string' },
      check: { type: 'string', multiple: true },
      sandbox: { type: 'string' },
      'allow-domain': { type: 'string', multiple: true },
      'no-session-file': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  for (const [flag, v] of [['effort', values.effort], ['escalate', values.escalate]] as const)
    if (v !== undefined && !EFFORTS.includes(v as Effort) && !(flag === 'escalate' && v === 'off')) {
      console.error(`unknown --${flag} ${v}`);
      return 2;
    }
  const format = values['output-format'];
  if (format !== 'text' && format !== 'json' && format !== 'stream-json') {
    console.error(`unknown --output-format ${format}`);
    return 2;
  }
  const base: TuiArgs = {
    ...(values.model ? { model: values.model } : {}),
    cwd: values.cwd ?? process.cwd(),
    ...(values['max-turns'] ? { maxTurns: Number(values['max-turns']) } : {}),
    ...(values['max-budget-usd'] ? { maxBudgetUsd: Number(values['max-budget-usd']) } : {}),
    ...(values.effort ? { effort: values.effort as Effort } : {}),
    ...(values.escalate ? { escalate: values.escalate } : {}),
    ...(values['no-session-file'] ? { noSessionFile: true } : {}),
    ...(values.permission ? { permission: values.permission } : {}),
    ...(values.allow ? { allow: values.allow } : {}),
    ...(values.deny ? { deny: values.deny } : {}),
    ...(values.unlock ? { unlock: values.unlock } : {}),
    ...(values.privacy ? { privacy: values.privacy } : {}),
    ...(values.fallback ? { fallback: values.fallback } : {}),
    ...(values['on-quota'] ? { onQuota: values['on-quota'] } : {}),
    ...(values.thread ? { thread: values.thread } : {}),
    ...(values.spawn ? { spawn: values.spawn } : {}),
    ...(values.lsp ? { lsp: values.lsp } : {}),
    ...(values.ask ? { ask: values.ask } : {}),
    ...(values.todo ? { todo: values.todo } : {}),
    ...(values.browser ? { browser: values.browser } : {}),
    ...(values.profile ? { profile: values.profile } : {}),
    ...(values.swarm ? { swarm: values.swarm } : {}),
    ...(values.workers ? { workers: values.workers } : {}),
    ...(values['handoff-at'] ? { handoffAt: values['handoff-at'] } : {}),
    ...(values.handoff ? { handoff: values.handoff } : {}),
    ...(values.review ? { review: values.review } : {}),
    ...(values.goal ? { goal: values.goal } : {}),
    ...(values['goal-judge'] ? { goalJudge: values['goal-judge'] } : {}),
    ...(values['goal-mode'] ? { goalMode: values['goal-mode'] } : {}),
    ...(values.advisor ? { advisor: values.advisor } : {}),
    ...(values.classifier ? { classifier: values.classifier } : {}),
    ...(values.plan ? { plan: values.plan } : {}),
    ...(values.check ? { checks: values.check } : {}),
    ...(values.sandbox ? { sandbox: values.sandbox } : {}),
    ...(values['allow-domain'] ? { allowDomains: values['allow-domain'] } : {}),
  };
  let prompt = values.print ?? positionals.join(' ');
  // No prompt at a terminal: the interactive client, on the same run path.
  if (!prompt && process.stdin.isTTY && process.stdout.isTTY && values.print === undefined) {
    if (base.noSessionFile) {
      console.error('cedia: the TUI keeps its turns in a thread, so it needs session files');
      return 2;
    }
    // Loaded only here, so a headless run never pays for the terminal library.
    const { runTui } = await import('./clients/tui/main.ts');
    return runTui(base);
  }
  if (!prompt && !process.stdin.isTTY) prompt = (await new Response(Bun.stdin.stream()).text()).trim();
  if (!prompt) {
    console.error(USAGE);
    return 2;
  }
  try {
    const result = await runHeadless({ ...base, prompt, outputFormat: format });
    // A question for the owner is not a failure: the thread waits for the answer.
    const ok = result.subtype === 'success' || result.subtype === 'asked';
    if (!ok && format === 'text') console.error(`cedia: ${result.subtype}`);
    return ok && (!result.goal || result.goal.verdict === 'met') ? 0 : 1;
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 1;
  }
}

function lintFiles(files: string[]): number {
  if (!files.length) {
    console.error('usage: cedia lint-session <file.jsonl>...');
    return 2;
  }
  let bad = 0;
  for (const file of files) {
    const findings = lintSession(SessionLog.load(file).events);
    for (const f of findings) console.log(`${file}:${f.at + 1}: ${f.rule}: ${f.message}`);
    if (findings.length) bad++;
  }
  return bad ? 1 : 0;
}

function usage(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { cwd: { type: 'string' }, thread: { type: 'string' }, last: { type: 'string' }, since: { type: 'string' }, all: { type: 'boolean' }, json: { type: 'boolean' } },
  });
  const cwd = values.cwd ?? process.cwd();
  const home = cediaHome();
  try {
    const since = values.since === undefined ? undefined : sinceOf(values.since);
    let inputs: { path: string; project?: string }[] = positionals.map((path) => ({ path }));
    if (!inputs.length && values.thread) {
      const store = new ThreadStore(threadsDir(home, projectKey(cwd)));
      // The thread and every sub-thread under it, however deep.
      const all = store.list();
      const ids = [values.thread];
      for (let i = 0; i < ids.length; i++) ids.push(...all.filter((t) => t.parent === ids[i]).map((t) => t.id));
      inputs = ids.flatMap((id) => store.read(id).sessions.map((s) => ({ path: s.path ?? sessionPath(cwd, s.sessionId, home), project: projectKey(cwd) })));
    } else if (!inputs.length) {
      const root = join(home, 'sessions');
      const keys = values.all ? (existsSync(root) ? readdirSync(root) : []) : [projectKey(cwd)];
      const found = keys.flatMap((project) => {
        const dir = join(root, project);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
        return readdirSync(dir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ path: join(dir, f), project, mtime: statSync(join(dir, f)).mtimeMs }));
      });
      found.sort((a, b) => b.mtime - a.mtime);
      // A range reads every session written in it; otherwise the newest few.
      inputs = since ? found.filter((f) => f.mtime >= since.getTime()) : found.slice(0, Number(values.last ?? 20));
    }
    // Which thread each session is part of, from each project's threads.
    const threadOf = new Map<string, { thread: string; title: string }>();
    for (const project of new Set(inputs.map((i) => i.project).filter((p) => p !== undefined))) {
      for (const t of new ThreadStore(threadsDir(home, project)).list()) {
        for (const s of t.sessions) threadOf.set(s.sessionId, { thread: t.id, title: t.title });
      }
    }
    const sessions: SessionInput[] = inputs
      .filter((i) => existsSync(i.path))
      .map((i) => {
        const id = basename(i.path).replace(/\.jsonl$/, '');
        const t = threadOf.get(id);
        return { id, events: readEventsLenient(readFileSync(i.path, 'utf8')).filter(isUsageEvent), ...(i.project ? { project: i.project } : {}), ...(t ?? {}) };
      });
    if (!sessions.length) {
      // An empty range is an answer, not an error, for a client that asks for one.
      if (since && values.json) {
        console.log(JSON.stringify(usageReport([], { since })));
        return 0;
      }
      console.error('cedia: no session logs to read');
      return 1;
    }
    const report = usageReport(sessions, { since });
    console.log(values.json ? JSON.stringify(report) : formatUsage(report));
    return 0;
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 1;
  }
}

function threads(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { cwd: { type: 'string' }, all: { type: 'boolean' }, session: { type: 'string' }, note: { type: 'string' }, force: { type: 'boolean' }, json: { type: 'boolean' } },
  });
  const store = new ThreadStore(threadsDir(cediaHome(), projectKey(values.cwd ?? process.cwd())));
  const [cmd = 'list', id, ...rest] = positionals;
  try {
    if (cmd === 'list') {
      const all = store.list().filter((t) => values.all || !t.archived);
      console.log(all.length ? all.map(threadLine).join('\n') : 'no threads in this project');
      return 0;
    }
    if (cmd === 'show' && id) {
      const t = store.read(id);
      const lines = [`${t.id}  ${t.state}  ${t.title}`, ...(t.by ? [`opened by ${t.by}`] : []), ...(t.profile ? [`profile ${t.profile}`] : []), '', t.task, ''];
      for (const s of t.sessions) lines.push(`session ${s.sessionId}  ${s.model}  ${s.why}${s.rewound ? '  (rewound)' : ''}${s.path ? `  ${s.path}` : ''}`);
      if (t.runs.length) lines.push('', ...runLines(t));
      if (t.handoff) lines.push('', `handoff from ${t.handoff.sessionId}:`, t.handoff.note);
      if (t.result) lines.push('', 'result:', t.result);
      for (const m of t.messages) lines.push('', `message ${m.id} from ${m.from} at ${m.at}${m.unsent ? ' (unsent)' : t.pending.includes(m) ? ' (not seen yet)' : ''}:`, m.text);
      if (t.todo?.length) lines.push('', `todo ${t.todo.filter((i) => i.state === 'done').length}/${t.todo.length}:`, ...t.todo.map((i) => `  ${i.state === 'done' ? '[x]' : i.state === 'doing' ? '[>]' : '[ ]'} ${i.text}`));
      if (t.question) lines.push('', `question from ${t.question.sessionId}:`, t.question.question, ...(t.question.options ?? []).map((o, i) => `  ${i + 1}. ${o}`), `answer with: cedia -p "<answer>" --thread ${t.id}`);
      for (const r of t.ratings) lines.push('', `rated ${r.rating} at ${r.at}${r.sessionId ? ` (session ${r.sessionId})` : ''}${r.note ? `: ${r.note}` : ''}`);
      console.log(lines.join('\n'));
      return 0;
    }
    if ((cmd === 'archive' || cmd === 'unarchive') && id) {
      if (!store.has(id)) throw new Error(`no thread ${id} in this project`);
      store.append(id, { kind: 'archived', archived: cmd === 'archive' });
      console.log(`${cmd}d ${id}`);
      return 0;
    }
    if (cmd === 'send' && id && rest.length) {
      const mid = store.send(id, 'user', rest.join(' '));
      console.log(`sent to ${id} as ${mid}`);
      return 0;
    }
    if (cmd === 'unsend' && id) {
      const taken = store.unsend(id, rest);
      console.log(taken.length ? `unsent ${taken.join(', ')} from ${id}` : `no messages waiting in ${id}`);
      return 0;
    }
    if ((cmd === 'undo' || cmd === 'redo') && id) {
      if (!store.has(id)) throw new Error(`no thread ${id} in this project`);
      const r = restoreTurn(store, id, (cwd) => workspaceSnapshots(cwd, cediaHome()), cmd, { force: values.force ?? false });
      if ('error' in r) throw new Error(r.error);
      // A client reads the files moved and the ones left; leaving some is not a failure there.
      if (values.json) {
        console.log(JSON.stringify(r));
        return 0;
      }
      console.log(restoredText(r));
      return r.skipped.length ? 1 : 0;
    }
    if (cmd === 'rewind' && id && rest.length <= 1) {
      if (!store.has(id)) throw new Error(`no thread ${id} in this project`);
      if (!rest.length) {
        const runs = runLines(store.read(id));
        console.log(runs.length ? runs.join('\n') : `thread ${id} has no run to rewind to`);
        return 0;
      }
      const r = rewindThread(store, id, Number(rest[0]), { open: (cwd) => workspaceSnapshots(cwd, cediaHome()), sessionFile: (cwd, sid) => sessionPath(cwd, sid) }, { force: values.force ?? false });
      // A refusal is the answer too: the client offers --force when it goes past it.
      if (values.json) {
        const out: RewindResult = 'error' in r ? r : { run: r.run.id, restored: r.restored, ...(r.sessionId ? { sessionId: r.sessionId } : {}) };
        console.log(JSON.stringify(out));
        return 'error' in r ? 1 : 0;
      }
      if ('error' in r) throw new Error(r.error);
      console.log(rewoundText(r));
      return 0;
    }
    if (cmd === 'fork' && id && rest.length === 1) {
      if (!store.has(id)) throw new Error(`no thread ${id} in this project`);
      const r = forkThread(store, id, rest[0]!, { sessionFile: (cwd, sid) => sessionPath(cwd, sid) });
      if ('error' in r) throw new Error(r.error);
      console.log(values.json ? JSON.stringify({ thread: r.thread, run: r.run.id, ...(r.sessionId ? { sessionId: r.sessionId } : {}) }) : `forked ${id} at run ${JSON.stringify(r.run.prompt.split('\n')[0])} into ${r.thread}; send the edited message with cedia -p <text> --thread ${r.thread}`);
      return 0;
    }
    if (cmd === 'diff' && id) {
      if (!store.has(id)) throw new Error(`no thread ${id} in this project`);
      const change = threadTurn(store, id);
      const snapshots = change && workspaceSnapshots(change.cwd, cediaHome());
      if (!change || !snapshots) throw new Error(`thread ${id} has no turn that changed files`);
      process.stdout.write(sinceTurn(snapshots, change));
      return 0;
    }
    if (cmd === 'rate' && id && rest.length === 1) {
      store.rate(id, rest[0] as Rating, { ...(values.session ? { sessionId: values.session } : {}), ...(values.note ? { note: values.note } : {}) });
      console.log(`rated ${id} ${rest[0]}`);
      return 0;
    }
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 1;
  }
  console.error('usage: cedia threads [list [--all] | show <id> | send <id> <text> | unsend <id> [<msg>...] | diff <id> | undo <id> [--force] [--json] | redo <id> [--force] [--json] | rewind <id> [<n>] [--force] [--json] | fork <id> <n|run> [--json] | rate <id> <up|down> [--session <sid>] [--note <text>] | archive <id> | unarchive <id>] [--cwd <dir>]');
  return 2;
}

function skills(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { cwd: { type: 'string' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  if (parsed.positionals.length && parsed.positionals[0] !== 'list') {
    console.error('usage: cedia skills [list] [--cwd <dir>]');
    return 2;
  }
  const found = loadSkills(resolve(parsed.values.cwd ?? process.cwd()), cediaHome());
  // A repository's description could carry terminal escapes; they are shown as text.
  const shown = (t: string) => t.replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  console.log(found.length ? found.map((s) => `${s.name}  (${s.source})  ${shown(s.dir)}\n    ${shown(s.description)}`).join('\n') : 'no skills here');
  return 0;
}

function models(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { json: { type: 'boolean' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  let list;
  try {
    list = modelList(loadRoles().code.ref, process.env, processKeychain());
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 1;
  }
  console.log(parsed.values.json ? JSON.stringify(list) : list.models.map((m) => modelLine(m, m.ref === list.default)).join('\n'));
  return 0;
}

function permissions(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { json: { type: 'boolean' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  let list: PermissionList;
  try {
    list = { default: loadPermissionSetting(), modes: PERMISSION_ENTRIES };
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 1;
  }
  console.log(parsed.values.json ? JSON.stringify(list) : list.modes.map((m) => `${m.mode === list.default ? '*' : ' '} ${m.mode.padEnd(10)} ${m.description}`).join('\n'));
  return 0;
}

function commands(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { cwd: { type: 'string' }, json: { type: 'boolean' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  const list = commandList(loadSkills(resolve(parsed.values.cwd ?? process.cwd()), cediaHome()));
  const shown = (t: string) => t.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  console.log(parsed.values.json ? JSON.stringify(list) : list.commands.map((c) => `/${c.name}${c.argumentHint ? ` ${shown(c.argumentHint)}` : ''}  ${shown(c.description)}`).join('\n') || 'no commands here');
  return 0;
}

function schedules(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { cwd: { type: 'string' }, json: { type: 'boolean' }, every: { type: 'string' }, thread: { type: 'string' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const cwd = resolve(values.cwd ?? process.cwd());
  const store = new ScheduleStore(schedulesPath(cediaHome(), projectKey(cwd)));
  const [cmd = 'list', ...rest] = positionals;
  const show = (list: Schedule[]) => console.log(values.json ? JSON.stringify(list) : list.length ? list.map(scheduleLine).join('\n') : 'no schedules');
  try {
    if (cmd === 'list') {
      show(store.list());
      return 0;
    }
    if (cmd === 'due') {
      show(store.due());
      return 0;
    }
    if (cmd === 'add' && rest.length >= 2 && values.thread) {
      const threads = new ThreadStore(threadsDir(cediaHome(), projectKey(cwd)));
      if (!threads.has(values.thread)) throw new Error(`no thread ${values.thread} in this project`);
      const first = whenOf(rest[0]!);
      if (!first) throw new Error(`not a time: ${rest[0]} (an ISO time, or a delay like 30m or 2h)`);
      const every = values.every === undefined ? undefined : minutesOf(values.every);
      if (values.every !== undefined && every === undefined) throw new Error(`not a duration: ${values.every} (like 1h or 1d)`);
      show([store.add({ prompt: rest.slice(1).join(' '), thread: values.thread, first, ...(every ? { every } : {}) })]);
      return 0;
    }
    if (rest.length === 1 && (cmd === 'cancel' || cmd === 'pause' || cmd === 'resume' || cmd === 'fire')) {
      const id = rest[0]!;
      if (cmd === 'cancel') store.cancel(id);
      else if (cmd === 'fire') {
        show([store.fire(id)]);
        return 0;
      } else store.setEnabled(id, cmd === 'resume');
      console.log(`${cmd === 'cancel' ? 'cancelled' : cmd === 'pause' ? 'paused' : 'resumed'} ${id}`);
      return 0;
    }
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 1;
  }
  console.error('usage: cedia schedules [list | due | add <when> <prompt> --thread <id> [--every <dur>] | cancel|pause|resume|fire <id>] [--json] [--cwd <dir>]');
  return 2;
}

function memory(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { cwd: { type: 'string' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message} (put -- before a note that starts with -)`);
    return 2;
  }
  const { values, positionals } = parsed;
  const store = new MemoryStore(memoryPath(cediaHome(), projectKey(resolve(values.cwd ?? process.cwd()))));
  const [cmd = 'list', ...rest] = positionals;
  try {
    if (cmd === 'list') {
      const notes = store.notes();
      // A session's note could carry terminal escapes; they are shown as text.
      const shown = (t: string) => t.replace(/[\x00-\x1f\x7f\x9b]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
      console.log(notes.length ? notes.map((n) => `${n.id}  ${n.at.slice(0, 10)}  ${n.from}: ${shown(n.text)}`).join('\n') : 'no notes for this project');
      return 0;
    }
    if (cmd === 'add' && rest.length) {
      console.log(`kept as note ${store.add(rest.join(' '), 'user').id}`);
      return 0;
    }
    if (cmd === 'forget' && rest.length === 1) {
      store.forget(rest[0]!);
      console.log(`forgot ${rest[0]}`);
      return 0;
    }
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 1;
  }
  console.error('usage: cedia memory [list | add <text> | forget <id>] [--cwd <dir>]');
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
