import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runHeadless } from './clients/headless/main.ts';
import type { TuiArgs } from './clients/tui/main.ts';
import { ALIASES } from './core/providers/catalog.ts';
import { GUARDS, PERMISSION_ENTRIES, type PermissionList } from './core/safety/policy.ts';
import { applyAllowRules, suggestAllowRules } from './core/safety/suggest.ts';
import { cediaHome, loadPermissionSetting, loadPolicy, loadRoles, loadManagedSettings, loadResolvedSettings, loadPolicyLimits, savePolicyLimits } from './core/config.ts';
import { processKeychain } from './core/providers/keychain.ts';
import { modelLine, modelList } from './core/providers/models.ts';
import { threadLine, threadsDir, ThreadStore, type Rating } from './core/project/threads.ts';
import { memoryPath, MemoryStore } from './core/project/memory.ts';
import { TeamStore, teamLine } from './core/project/teams.ts';
import { findMagicDocs } from './core/project/magicdocs.ts';
import { fetchMdmSettings } from './core/project/mdm-remote.ts';
import { listRemoteSessions, runRemote, fetchRemoteSession } from './core/project/remote.ts';
import { voiceInput } from './core/project/voice.ts';
import { loadKeybindings } from './clients/tui/keybindings/loader.ts';
import { daemonCmd } from './clients/daemon/cmd.ts';
import { loadOnboarding, saveOnboarding, acceptTrust, markStep, isComplete } from './clients/tui/onboarding.ts';
import { loadOutputStyles, getStyle, stylesDir } from './core/output-styles/styles.ts';
import { isAlive, listBgSessions, recordStart, recordStop, bgPath, daemonPidPath, readBgEvents } from './core/project/background.ts';
import { installPlugin, uninstallPlugin, setPluginEnabled, updatePlugin, listInstalled, loadManifest, discoverPlugins, addMarketplace, removeMarketplace, updateMarketplace, loadMarketplaces } from './core/plugins/plugins.ts';
import { consolidateMemory } from './core/project/consolidate.ts';
import { extractMemories } from './core/memory/extract.ts';
import { minutesOf, scheduleLine, ScheduleStore, schedulesPath, whenOf, type Schedule } from './core/project/schedules.ts';
import { commandList, loadSkills } from './core/skills/skills.ts';
import { restoredText, restoreTurn, sinceTurn, threadTurn } from './core/project/undo.ts';
import { rewindThread, rewoundText, runLines, type RewindResult } from './core/project/rewind.ts';
import { addMcp, checkMcp, listMcp, removeMcp } from './core/mcp/manage.ts';
import { commitFiles, currentBranch, headCommit, prPlan, pushAndOpenPr, threadChanges, type CommitDraft, type Committed, type PrOpened } from './core/project/commit.ts';
import { draftCommitMessage } from './core/project/draft.ts';
import { deleteThread } from './core/project/delete.ts';
import { type ForkResult, forkThread } from './core/project/fork.ts';
import { workspaceSnapshots } from './core/safety/snapshot.ts';
import { lintSession } from './core/session/lint.ts';
import { projectKey, sessionPath, SessionLog } from './core/session/log.ts';
import { formatUsage, isUsageEvent, readEventsLenient, sinceOf, usageReport, type SessionInput } from './core/session/usage.ts';
import { selectSessions } from './core/session/select.ts';
import { EFFORTS, type Effort } from './core/types.ts';
import { doctorReport } from './core/doctor.ts';
import { selfSpawnArgs } from './core/self.ts';
import { versionInfo } from './protocol/version.ts';

// Multi-repo workspace: --project <key> overrides the project key for this invocation, so threads in different
// repositories can file under one workspace. Set early, before any command parses args.
const _projectFlagIndex = process.argv.indexOf('--project');
if (_projectFlagIndex >= 0 && process.argv[_projectFlagIndex + 1]) process.env.CEDIA_PROJECT = process.argv[_projectFlagIndex + 1];

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
      --plan-when <auto|always|never> with a plan role: auto (default) asks the writer's model first whether the
                               message is work a plan helps, so a greeting or a question skips the planner
                               ("planWhen" in settings)
      --triage <ref>           the model that decides (default: the code model; roles.triage in settings)
      --output-style <name>    report style by name (default, explanatory, learning, terse; settings, cedia output-style)
      --cache-ttl <5m|1h>      how long the writer's cached prompt lasts on Claude API models between requests.
                               Default 5m for -p, 1h in the TUI (writes cost 2x input instead of 1.25x)
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
      --image <file>           show the model this image (PNG, JPEG, GIF, WebP) with the prompt; repeatable
      --sandbox <s>            auto | on | off: OS sandbox for bash (default: $CEDIA_SANDBOX, settings, auto)
      --allow-domain <host>    let sandboxed commands reach this host; repeatable
      --no-session-file        keep the session log in memory only
      --no-mcp                 start no MCP server: the run sees core tools only, at core-tools cost

       cedia lint-session <file.jsonl>...   check session logs against the trust invariants
       cedia usage [<file.jsonl>... | --thread <id> | --last <n> | --since <day|Nd>] [--all] [--json] [--cwd <dir>]
                                            where the spend went: input by source, the costliest tool results,
                                            cache misses by cause, and cost by day, model, project and thread
                                            (default: this project's last 20 sessions; --since: every session
                                            in the range; --all: every project)
       cedia threads [--all] [--cwd <dir>]  list this project's threads (--all: archived ones and side chats too)
       cedia threads show <id>              a thread's task, state, sessions, handoff note, result and messages
       cedia threads send <id> <text>       leave a message the thread sees at its next turn; prints the message id
       cedia threads unsend <id> [<msg>...] take back your messages it has not seen yet (all of them by default)
       cedia threads rate <id> <up|down> [--session <sid>] [--note <text>]
                                            rate an answer (default: the thread's latest) for picking eval cases;
                                            no model ever sees it
       cedia threads archive|unarchive <id> hide a thread from the list, or bring it back
       cedia threads rename <id> <title>    give a thread a title of your own
       cedia threads delete <id> [--force] [--json]
                                            delete a thread for good: its file, its sub-threads and their session
                                            logs (refused while it runs unless --force; worktrees are kept)
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
       cedia threads fork <id> <n|run|end> [--side] [--json]
                                            a new thread whose conversation is this one's just before run n (or the
                                            run with that id), for sending its message again, edited; the original
                                            thread and the files are left as they are. end: as it stands now, even
                                            while it works; --side marks it a side chat, which list leaves out
                                            Without n, lists the runs
       cedia schedules [list | due] [--json]
                                            the project's scheduled prompts, or the ones due now. Whoever runs
                                            threads (the desktop's daemon, cron) runs each due one with
                                            cedia -p <prompt> --thread <thread> after cedia schedules fire <id>
       cedia schedules add <when> <prompt> --thread <id> [--every <dur>]
                                            when: an ISO time or a delay (30m, 2h); every: 1h, 1d, 1w (at least 5m)
       cedia schedules cancel|pause|resume|fire <id>
       cedia daemon [--once] [--interval <s>] [--max <n>] [--json] [--cwd <dir>]
                                            run queued threads and due schedules in cedia processes of their
                                            own; --once runs one pass (for cron), otherwise it loops until
                                            stopped. cedia daemon stop|status controls it
       cedia memory [list | add <text> | forget <id> | consolidate]
                                            the project's memory: short facts every new session gets in its first
                                            turn; writer sessions add to it with the remember tool
       cedia models [--json]                the models a session may use, which of them have a key here, and the
                                            one the code role takes now (marked *)
       cedia permissions [--json]           the permission modes a run may take (--permission) and the default
       cedia permissions suggest [<file>...] [--thread <id>] [--last <n>] [--apply] [--json]
                                            propose allow rules from calls past runs stopped (read-only
                                            commands and exact MCP tools only); --apply adds them to the
                                            user's allow list
       cedia mcp [list] [--json]            the MCP servers in ~/.cedia/settings.json (env and header names only)
       cedia mcp check <name> [--json]      start one as a run would and list its tools
       cedia mcp add <name> (--command <cmd> [--arg <a>]... [--env K=V]... | --url <url> [--header K=V]...)
                     [--read-only] [--timeout <sec>]
                                            add a server, or replace the one of that name
       cedia mcp remove <name>              take a server out
       cedia commit --thread <id> [--cwd <dir>] [--model <ref>] [--json]
                                            draft a message for the files the thread changed; commits nothing
       cedia commit --thread <id> --message <m> [--file <f>]... [--json]
                                            commit those files (all of them without --file), nothing else
       cedia pr [--check] [--cwd <dir>] [--json]
                                            push the branch and open its pull request through gh (never the
                                            default branch); --check only says where it would go
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
  if (argv[0] === 'teams') return teamsCmd(argv.slice(1));
  if (argv[0] === 'magic-docs') return magicDocsCmd(argv.slice(1));
  if (argv[0] === 'mdm') return mdmCmd(argv.slice(1));
  if (argv[0] === 'serve') return serveCmd(argv.slice(1));
  if (argv[0] === 'remote') return remoteCmd(argv.slice(1));
  if (argv[0] === 'teleport') return teleportCmd(argv.slice(1));
  if (argv[0] === 'voice') return voiceCmd(argv.slice(1));
  if (argv[0] === 'output-style') return outputStyle(argv.slice(1));
  if (argv[0] === 'doctor') return doctor(argv.slice(1));
  if (argv[0] === 'onboarding') return onboarding(argv.slice(1));
  if (argv[0] === 'agents') return agentsCmd(argv.slice(1));
  if (argv[0] === 'logs') return logsCmd(argv.slice(1));
  if (argv[0] === 'attach') return attachCmd(argv.slice(1));
  if (argv[0] === 'daemon') return daemonCmd(argv.slice(1));
  if (argv[0] === 'stop' || argv[0] === 'kill') return stopCmd(argv.slice(1), argv[0] === 'kill');
  if (argv[0] === 'respawn') return respawnCmd(argv.slice(1));
  if (argv[0] === 'plugin') return plugin(argv.slice(1));
  if (argv[0] === 'marketplace') return marketplace(argv.slice(1));
  if (argv[0] === 'settings') return settings(argv.slice(1));
  if (argv[0] === 'policy-limits') return policyLimits(argv.slice(1));
  if (argv[0] === 'schedules') return schedules(argv.slice(1));
  if (argv[0] === 'skills') return skills(argv.slice(1));
  if (argv[0] === 'commands') return commands(argv.slice(1));
  if (argv[0] === 'permissions') return permissions(argv.slice(1));
  if (argv[0] === 'models') return await models(argv.slice(1));
  if (argv[0] === 'mcp') return mcp(argv.slice(1));
  if (argv[0] === 'commit') return commit(argv.slice(1));
  if (argv[0] === 'pr') return pr(argv.slice(1));
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
      'cache-ttl': { type: 'string' },
      'plan-when': { type: 'string' },
      'output-style': { type: 'string' },
      triage: { type: 'string' },
      ask: { type: 'string' },
      todo: { type: 'string' },
      'auto-dream': { type: 'string' },
      'prompt-suggestions': { type: 'string' },
      browser: { type: 'string' },
      'context-management': { type: 'string' },
      'streaming-tools': { type: 'boolean' },
      bg: { type: 'boolean' },
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
      image: { type: 'string', multiple: true },
      sandbox: { type: 'string' },
      'allow-domain': { type: 'string', multiple: true },
      'no-session-file': { type: 'boolean' },
      'no-mcp': { type: 'boolean' },
      tui: { type: 'string' },
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
    ...(values['no-mcp'] ? { noMcp: true } : {}),
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
    ...(values['cache-ttl'] ? { cacheTtl: values['cache-ttl'] } : {}),
    ...(values['plan-when'] ? { planWhen: values['plan-when'] } : {}),
    ...(values['output-style'] ? { outputStyle: values['output-style'] } : {}),
    ...(values.triage ? { triage: values.triage } : {}),
    ...(values.ask ? { ask: values.ask } : {}),
    ...(values.todo ? { todo: values.todo } : {}),
    ...(values.browser ? { browser: values.browser } : {}),
    ...(values['context-management'] ? { 'context-management': values['context-management'] } : {}),
    ...(values['streaming-tools'] ? { streamingTools: true } : {}),
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
    ...(values.image ? { images: values.image } : {}),
    ...(values.sandbox ? { sandbox: values.sandbox } : {}),
    ...(values['allow-domain'] ? { allowDomains: values['allow-domain'] } : {}),
    ...(values['prompt-suggestions'] ? { promptSuggestions: values['prompt-suggestions'] } : {}),
  };
  let prompt = values.print ?? positionals.join(' ');
  // No prompt at a terminal: the interactive client, on the same run path.
  if (!prompt && process.stdin.isTTY && process.stdout.isTTY && values.print === undefined) {
    if (base.noSessionFile) {
      console.error('cedia: the TUI keeps its turns in a thread, so it needs session files');
      return 2;
    }
    const tuiChoice = values.tui ?? process.env.CEDIA_TUI ?? 'ink';
    if (tuiChoice === 'ink') {
      const { runInkTui } = await import('./clients/tui-ink/index.ts');
      return await runInkTui(base as TuiArgs);
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
  if (values.bg) {
    const { ThreadStore, threadsDir } = await import('./core/project/threads.ts');
    const { sessionPath } = await import('./core/session/log.ts');
    const { projectKey } = await import('./core/session/log.ts');
    const { recordStart } = await import('./core/project/background.ts');
    const store = new ThreadStore(threadsDir(cediaHome(), projectKey(base.cwd ?? process.cwd())));
    const tid = store.open(prompt, {});
    const sid = crypto.randomUUID();
    const logPath = sessionPath(base.cwd ?? process.cwd(), sid);
    const child = Bun.spawn(selfSpawnArgs(['-p', prompt, '--thread', tid, '--sandbox', base.sandbox ?? 'auto', '--output-format', 'json']), { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    // detach
    try { child.unref(); } catch {}
    const bgid = `bg-${crypto.randomUUID().slice(0, 8)}`;
    recordStart(cediaHome(), projectKey(base.cwd ?? process.cwd()), { id: bgid, thread: tid, pid: child.pid ?? 0, logPath });
    console.log(bgid);
    return 0;
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
    options: { cwd: { type: 'string' }, all: { type: 'boolean' }, session: { type: 'string' }, note: { type: 'string' }, force: { type: 'boolean' }, side: { type: 'boolean' }, json: { type: 'boolean' } },
  });
  const store = new ThreadStore(threadsDir(cediaHome(), projectKey(values.cwd ?? process.cwd())));
  const [cmd = 'list', id, ...rest] = positionals;
  try {
    if (cmd === 'list') {
      // A side chat belongs to the thread it was forked from, and shows beside it in a client.
      const all = store.list().filter((t) => values.all || (!t.archived && !t.side));
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
    if (cmd === 'rename' && id && rest.length) {
      const title = store.rename(id, rest.join(' '));
      console.log(`renamed ${id}: ${title}`);
      return 0;
    }
    if (cmd === 'delete' && id && !rest.length) {
      const r = deleteThread(store, id, { force: values.force ?? false });
      if (values.json) {
        console.log(JSON.stringify(r));
        return 'error' in r ? 1 : 0;
      }
      if ('error' in r) throw new Error(r.error);
      console.log(`deleted ${r.threads.join(', ')} and ${r.sessions.length} session log${r.sessions.length === 1 ? '' : 's'}`);
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
      const r = forkThread(store, id, rest[0]!, { sessionFile: (cwd, sid) => sessionPath(cwd, sid) }, { side: values.side ?? false });
      if ('error' in r) throw new Error(r.error);
      const out: ForkResult = { thread: r.thread, ...(r.run ? { run: r.run.id } : {}), ...(r.sessionId ? { sessionId: r.sessionId } : {}) };
      const at = r.run ? `at run ${JSON.stringify(r.run.prompt.split('\n')[0])}` : 'at its end';
      console.log(values.json ? JSON.stringify(out) : `forked ${id} ${at} into ${r.thread}; send ${r.run ? 'the edited message' : 'a question'} with cedia -p <text> --thread ${r.thread}`);
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
  console.error('usage: cedia threads [list [--all] | show <id> | send <id> <text> | unsend <id> [<msg>...] | diff <id> | undo <id> [--force] [--json] | redo <id> [--force] [--json] | rewind <id> [<n>] [--force] [--json] | fork <id> <n|run|end> [--side] [--json] | rate <id> <up|down> [--session <sid>] [--note <text>] | archive <id> | unarchive <id> | rename <id> <title> | delete <id> [--force] [--json]] [--cwd <dir>]');
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

async function models(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { json: { type: 'boolean' }, refresh: { type: 'boolean' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  if (parsed.values.refresh) {
    try {
      const { refreshLocalModelCache } = await import('./core/providers/catalog.ts');
      await refreshLocalModelCache();
    } catch {}
  }
  let list;
  try {
    list = modelList(loadRoles().code.ref, process.env, processKeychain());
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 1;
  }
  console.log(parsed.values.json ? JSON.stringify(list) : [...list.models.map((m) => modelLine(m, m.ref === list.default)), ...list.modes.map((m) => `     ${m.name.padEnd(48)} ${m.label}`)].join('\n'));
  return 0;
}

async function mcp(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        command: { type: 'string' },
        arg: { type: 'string', multiple: true },
        env: { type: 'string', multiple: true },
        url: { type: 'string' },
        header: { type: 'string', multiple: true },
        'read-only': { type: 'boolean' },
        timeout: { type: 'string' },
      },
    });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [cmd = 'list', name, ...rest] = positionals;
  const pairs = (list: string[] | undefined, what: string) => {
    if (!list?.length) return undefined;
    return Object.fromEntries(
      list.map((p) => {
        const at = p.indexOf('=');
        if (at < 1) throw new Error(`--${what} takes NAME=value: ${p}`);
        return [p.slice(0, at), p.slice(at + 1)];
      }),
    );
  };
  try {
    if (cmd === 'list' && !name) {
      const list = listMcp();
      if (values.json) console.log(JSON.stringify(list));
      else console.log(list.servers.length ? list.servers.map((s) => `${s.name}  ${s.url ?? [s.command, ...(s.args ?? [])].join(' ')}${s.readOnly ? '  (read only)' : ''}${s.error ? `\n    ${s.error}` : ''}`).join('\n') : 'no MCP servers in ~/.cedia/settings.json');
      return 0;
    }
    if (cmd === 'check' && name && !rest.length) {
      const r = await checkMcp(name);
      if (values.json) console.log(JSON.stringify(r));
      else console.log(r.ok ? `${name}: ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}${r.tools.map((t) => `\n  ${t.name}${t.description ? `  ${t.description}` : ''}`).join('')}` : `${name}: ${r.error}`);
      return r.ok ? 0 : 1;
    }
    if (cmd === 'add' && name && !rest.length) {
      if (!values.command === !values.url) throw new Error('mcp add takes --command or --url');
      const common = { ...(values['read-only'] ? { readOnly: true } : {}), ...(values.timeout !== undefined ? { timeoutSec: Number(values.timeout) } : {}) };
      const env = pairs(values.env, 'env');
      const headers = pairs(values.header, 'header');
      addMcp(name, values.command ? { command: values.command, ...(values.arg?.length ? { args: values.arg } : {}), ...(env ? { env } : {}), ...common } : { url: values.url!, ...(headers ? { headers } : {}), ...common });
      console.log(`added MCP server ${name}`);
      return 0;
    }
    if (cmd === 'remove' && name && !rest.length) {
      removeMcp(name);
      console.log(`removed MCP server ${name}`);
      return 0;
    }
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 1;
  }
  console.error('usage: cedia mcp [list [--json] | check <name> [--json] | add <name> (--command <cmd> [--arg <a>]... [--env K=V]... | --url <url> [--header K=V]...) [--read-only] [--timeout <sec>] | remove <name>]');
  return 2;
}

// `cedia commit`: what the TUI's /commit does, for a client that shows the files and the message and asks before
// anything commits. Without --message it drafts one (the thread's writer model, else --model, else the code role's)
// and commits nothing; with it, it commits the files given (each one the thread changed), or all of them.
async function commit(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { thread: { type: 'string' }, cwd: { type: 'string' }, message: { type: 'string' }, file: { type: 'string', multiple: true }, model: { type: 'string' }, json: { type: 'boolean' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  const { values } = parsed;
  if (!values.thread) {
    console.error('usage: cedia commit --thread <id> [--cwd <dir>] [--model <ref>] [--message <m> [--file <f>]...] [--json]');
    return 2;
  }
  const fail = (error: string) => {
    if (values.json) console.log(JSON.stringify({ error } satisfies CommitDraft));
    else console.error(`cedia: ${error}`);
    return 1;
  };
  const cwd = resolve(values.cwd ?? process.cwd());
  const store = new ThreadStore(threadsDir(cediaHome(), projectKey(cwd)));
  if (!store.has(values.thread)) return fail(`no thread ${values.thread} in this project`);
  const snaps = workspaceSnapshots(cwd, cediaHome());
  if (!snaps) return fail('no snapshots for this directory, so cedia cannot tell which files the thread changed');
  const files = threadChanges(store, values.thread, cwd, snaps);
  if (!files.length) return fail('nothing this thread changed differs from HEAD');
  try {
    if (values.message === undefined) {
      const writer = store.read(values.thread).sessions.filter((s) => !s.rewound).at(-1)?.model;
      const { message } = await draftCommitMessage({ cwd, model: values.model ?? writer ?? loadRoles({}).code.ref, files });
      if (!message) return fail('the message came back empty: write one with --message');
      const branch = currentBranch(cwd);
      const draft: CommitDraft = { files, message, ...(branch ? { branch } : {}) };
      console.log(values.json ? JSON.stringify(draft) : [`would commit ${files.join(', ')}${branch ? ` on ${branch}` : ''}:`, '', message].join('\n'));
      return 0;
    }
    const message = values.message.trim();
    if (!message) return fail('the message is empty');
    const chosen = values.file?.length ? [...new Set(values.file)] : files;
    const others = chosen.filter((f) => !files.includes(f));
    if (others.length) return fail(`${others.join(', ')}: not changed by this thread, or no different from HEAD`);
    const r = commitFiles(cwd, chosen, message);
    if (!r.ok) return fail(`git commit failed: ${r.out}`);
    const done: Committed = { commit: headCommit(cwd) ?? '', subject: message.split('\n')[0]!, files: chosen };
    console.log(values.json ? JSON.stringify(done) : r.out.split('\n')[0] ?? 'committed');
    return 0;
  } catch (e) {
    return fail((e as Error).message);
  }
}

// `cedia pr`: what the TUI's /pr does once the user said yes. --check says where it would go, or why it cannot,
// without pushing, so a client asks with the branch and the base in view.
async function pr(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { cwd: { type: 'string' }, check: { type: 'boolean' }, json: { type: 'boolean' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  const { values } = parsed;
  const cwd = resolve(values.cwd ?? process.cwd());
  const plan = prPlan(cwd);
  if (values.check) {
    console.log(values.json ? JSON.stringify(plan) : plan.blocked ?? `would push ${plan.branch} and open a pull request${plan.base ? ` into ${plan.base}` : ''}`);
    return plan.blocked ? 1 : 0;
  }
  const r = await pushAndOpenPr(cwd);
  const url = r.out.match(/https?:\/\/\S+/g)?.at(-1);
  const opened: PrOpened = r.ok ? { branch: plan.branch!, ...(plan.base ? { base: plan.base } : {}), ...(url ? { url } : {}), out: r.out } : { error: r.out };
  if (values.json) console.log(JSON.stringify(opened));
  else if (r.ok) console.log(r.out);
  else console.error(`cedia: ${r.out}`);
  return r.ok ? 0 : 1;
}

function permissions(argv: string[]): number {
  const [sub, ...rest] = argv;
  if (sub === 'suggest') return suggest(rest);
  if (sub !== undefined && !sub.startsWith('-')) {
    console.error('usage: cedia permissions [--json] | suggest [<file.jsonl>...] [--thread <id>] [--last <n>] [--apply] [--json] [--cwd <dir>]');
    return 2;
  }
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

// `cedia permissions suggest`: propose allow rules from calls past runs stopped, and with --apply add the
// missing ones to the user's allow list (a repository's settings can only tighten, never grant).
function suggest(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { cwd: { type: 'string' }, thread: { type: 'string' }, last: { type: 'string' }, apply: { type: 'boolean' }, json: { type: 'boolean' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  const cwd = resolve(parsed.values.cwd ?? process.cwd());
  const home = cediaHome();
  const sessions = selectSessions({ cwd, home, ...(parsed.values.thread ? { thread: parsed.values.thread } : {}), ...(parsed.values.last ? { last: Number(parsed.values.last) } : {}), ...(parsed.positionals.length ? { files: parsed.positionals } : {}) });
  if (!sessions.length) {
    console.error('cedia: no session logs to read');
    return 1;
  }
  let policy;
  try {
    policy = loadPolicy(cwd);
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 1;
  }
  const r = suggestAllowRules(sessions, { allow: policy.allow, deny: policy.deny });
  if (parsed.values.apply) {
    let added: string[];
    try {
      added = applyAllowRules(home, r.suggestions.map((s) => s.rule)).added;
    } catch (e) {
      console.error(`cedia: ${(e as Error).message}`);
      return 1;
    }
    if (parsed.values.json) console.log(JSON.stringify({ ...r, added }));
    else console.log(added.length ? `added to ~/.cedia/settings.json: ${added.join(', ')}` : 'nothing new to add: every suggestion is already allowed');
    return 0;
  }
  if (parsed.values.json) console.log(JSON.stringify(r));
  else {
    console.log(r.suggestions.length ? r.suggestions.map((s) => `${s.rule}  (${s.hits} run${s.hits === 1 ? '' : 's'} stopped; e.g. ${s.example})`).join('\n') : 'no suggestions: nothing safely pre-approvable was stopped');
    if (r.skippedDeny || r.skippedUnsafe) console.log(`left out: ${r.skippedDeny} held by a deny rule or guard, ${r.skippedUnsafe} unsafe to pre-approve`);
  }
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

async function memory(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { cwd: { type: 'string' }, model: { type: 'string' }, json: { type: 'boolean' }, thread: { type: 'string' }, 'auto-dream': { type: 'string' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message} (put -- before a note that starts with -)`);
    return 2;
  }
  const { values, positionals } = parsed;
  const cwd = resolve(values.cwd ?? process.cwd());
  const store = new MemoryStore(memoryPath(cediaHome(), projectKey(cwd)));
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
    if (cmd === 'consolidate' && rest.length === 0) {
      const r = await consolidateMemory({ cwd, ...(values.model ? { model: values.model } : {}), force: true });
      if (values.json) console.log(JSON.stringify(r));
      else console.log(`consolidated: ${r.added} note${r.added === 1 ? '' : 's'} added (${r.sessionsScanned} session${r.sessionsScanned === 1 ? '' : 's'} scanned)`);
      return 0;
    }
    if (cmd === 'extract' && rest.length === 0) {
      const r = await extractMemories({ cwd, ...(values.model ? { model: values.model } : {}), ...(values.thread ? { thread: values.thread } : {}), force: true });
      if (values.json) console.log(JSON.stringify(r));
      else console.log(`extracted: ${r.added} note${r.added === 1 ? '' : 's'} added (${r.sessionsScanned} session${r.sessionsScanned === 1 ? '' : 's'} scanned)`);
      return 0;
    }
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 1;
  }
  console.error('usage: cedia memory [list | add <text> | forget <id> | consolidate] [--cwd <dir>] [--model <ref>] [--json]');
  return 2;
}

function doctor(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { json: { type: 'boolean' }, cwd: { type: 'string' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  const home = cediaHome();
  const cwd = parsed.values.cwd ?? process.cwd();
  const r = doctorReport(cwd, home);
  // Keybindings live client-side (core never imports clients), so they join the report here.
  const keybindings: Record<string, unknown> = {};
  try {
    keybindings.count = loadKeybindings(home).length;
  } catch (e) {
    keybindings.error = (e as Error).message;
  }
  const tier = (t: { present: boolean; ok: boolean; error?: string }) => (!t.present ? 'absent' : t.ok ? 'ok' : `error: ${t.error}`);
  // MCP servers that failed validation, by name.
  const bad = r.mcp.servers.filter((s) => s.error);
  if (parsed.values.json) console.log(JSON.stringify({ ...r, keybindings }));
  else {
    console.log(`cedia doctor`);
    console.log(`version: ${r.version} · bun ${r.bun}`);
    console.log(`home: ${home}`);
    console.log(`cwd: ${cwd}`);
    console.log(`sandbox: ${r.sandbox.available ? 'available' : 'unavailable'} (${r.sandbox.tool ?? 'no tool'})`);
    console.log(`settings: user ${tier(r.settings.user)}, managed ${tier(r.settings.managed)}, mdm ${tier(r.settings.mdm)}, resolved ${r.settings.resolved}`);
    console.log(`mdm: ${r.mdm.url ? 'url set' : 'no url'}, cache ${r.mdm.cache}`);
    console.log(`keybindings: ${keybindings.count ?? keybindings.error ?? 0}`);
    console.log(`mcp servers: ${r.mcp.servers.length ? r.mcp.servers.map((s) => s.name).join(', ') : 'none'}${bad.length ? ` (invalid: ${bad.map((s) => `${s.name}: ${s.error}`).join('; ')})` : ''}`);
  }
  return 0;
}

function settings(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { source: { type: 'string', default: 'resolved' }, json: { type: 'boolean' }, cwd: { type: 'string' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  const source = parsed.values.source ?? 'resolved';
  let data: unknown;
  if (source === 'user') {
    try { data = JSON.parse(readFileSync(join(cediaHome(), 'settings.json'), 'utf8')); } catch { data = {}; }
  }
  else if (source === 'managed') data = loadManagedSettings();
  else if (source === 'resolved') data = loadResolvedSettings();
  else if (source === 'policy') data = loadPolicyLimits() ?? {};
  else {
    console.error(`cedia: unknown --source ${source}`);
    return 2;
  }
  console.log(parsed.values.json ? JSON.stringify(data) : JSON.stringify(data, null, 2));
  return 0;
}

async function policyLimits(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { json: { type: 'boolean' }, write: { type: 'string' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  // With --write <json>, cache it (for tests/offline). Otherwise print cached.
  if (parsed.values.write) {
    try {
      savePolicyLimits(JSON.parse(parsed.values.write));
      console.log('saved policy limits');
      return 0;
    } catch (e) {
      console.error(`cedia: ${(e as Error).message}`);
      return 1;
    }
  }
  const cached = loadPolicyLimits();
  console.log(parsed.values.json ? JSON.stringify(cached ?? {}) : JSON.stringify(cached ?? {}, null, 2));
  return 0;
}

function plugin(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' }, marketplace: { type: 'string' }, all: { type: 'boolean' }, cwd: { type: 'string' } } });
  } catch (e) { console.error(`cedia: ${(e as Error).message}`); return 2; }
  const { values, positionals } = parsed;
  const home = cediaHome();
  const [cmd, ...rest] = positionals;
  try {
    if (cmd === 'list') {
      const plugins = listInstalled(home);
      if (values.json) console.log(JSON.stringify(plugins));
      else console.log(plugins.length ? plugins.map((p) => `${p.enabled ? '*' : ' '} ${p.name}@${p.version}  ${p.installPath}`).join('\\n') : 'no plugins installed');
      return 0;
    }
    if (cmd === 'install' && rest.length === 1) {
      const rec = installPlugin(rest[0]!, home);
      console.log(values.json ? JSON.stringify(rec) : `installed ${rec.name}@${rec.version}`);
      return 0;
    }
    if (cmd === 'uninstall' && rest.length === 1) {
      uninstallPlugin(rest[0]!, home);
      console.log(`uninstalled ${rest[0]}`);
      return 0;
    }
    if (cmd === 'enable' && rest.length === 1) { setPluginEnabled(rest[0]!, true, home); console.log(`enabled ${rest[0]}`); return 0; }
    if (cmd === 'disable' && rest.length === 1) { setPluginEnabled(rest[0]!, false, home); console.log(`disabled ${rest[0]}`); return 0; }
    if (cmd === 'update') {
      if (values.all) {
        for (const p of listInstalled(home)) updatePlugin(p.name, home);
        console.log('updated all');
        return 0;
      }
      if (rest.length === 1) { updatePlugin(rest[0]!, home); console.log(`updated ${rest[0]}`); return 0; }
    }
  } catch (e) { console.error(`cedia: ${(e as Error).message}`); return 1; }
  console.error('usage: cedia plugin [list | install <src> | uninstall <name> | enable <name> | disable <name> | update <name>|--all] [--json]');
  return 2;
}

function marketplace(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' } } });
  } catch (e) { console.error(`cedia: ${(e as Error).message}`); return 2; }
  const home = cediaHome();
  const [cmd, ...rest] = parsed.positionals;
  try {
    if (cmd === 'list' || !cmd) {
      const m = loadMarketplaces(home);
      if (parsed.values.json) console.log(JSON.stringify(m));
      else console.log(m.length ? m.map((x) => `${x.name}  ${x.source}`).join('\\n') : 'no marketplaces');
      return 0;
    }
    if (cmd === 'add' && rest.length >= 2) {
      addMarketplace(rest[0]!, rest.slice(1).join(' '), home);
      console.log(`added marketplace ${rest[0]}`);
      return 0;
    }
    if (cmd === 'remove' && rest.length === 1) {
      removeMarketplace(rest[0]!, home);
      console.log(`removed marketplace ${rest[0]}`);
      return 0;
    }
    if (cmd === 'update' && rest.length === 1) {
      updateMarketplace(rest[0]!, home);
      console.log(`updated marketplace ${rest[0]}`);
      return 0;
    }
  } catch (e) { console.error(`cedia: ${(e as Error).message}`); return 1; }
  console.error('usage: cedia marketplace [list | add <name> <source> | remove <name> | update <name>] [--json]');
  return 2;
}

function agentsCmd(argv: string[]): number {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: { json: { type: 'boolean' }, cwd: { type: 'string' } } }); } catch (e) { console.error(`cedia: ${(e as Error).message}`); return 2; }
  const home = cediaHome();
  const cwd = parsed.values.cwd ?? process.cwd();
  const slug = projectKey(cwd);
  const sessions = listBgSessions(home, slug);
  if (parsed.values.json) console.log(JSON.stringify(sessions));
  else console.log(sessions.length ? sessions.map((s) => `${s.id}  ${s.alive ? 'alive' : 'dead'}  thread=${s.thread}  pid=${s.pid}`).join('\\n') : 'no background sessions');
  return 0;
}

function logsCmd(argv: string[]): number {
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, options: { tail: { type: 'string' }, follow: { type: 'boolean' }, cwd: { type: 'string' } } }); } catch (e) { console.error(`cedia: ${(e as Error).message}`); return 2; }
  const id = parsed.positionals[0];
  if (!id) { console.error('usage: cedia logs <id> [--tail N] [--follow]'); return 2; }
  const home = cediaHome();
  const cwd = parsed.values.cwd ?? process.cwd();
  const slug = projectKey(cwd);
  const sessions = listBgSessions(home, slug);
  const s = sessions.find((x) => x.id === id);
  if (!s) { console.error(`no session ${id}`); return 1; }
  const tail = parsed.values.tail ? Number(parsed.values.tail) : 50;
  const { readFileSync, existsSync } = require('node:fs');
  if (!existsSync(s.logPath)) { console.log('(no log yet)'); return 0; }
  const lines = readFileSync(s.logPath, 'utf8').split('\\n');
  console.log(lines.slice(-tail).join('\\n'));
  return 0;
}

function attachCmd(argv: string[]): number {
  const id = argv[0];
  if (!id) { console.error('usage: cedia attach <id>'); return 2; }
  console.log(`attach ${id}: tailing log (Ctrl+C to detach)`);
  return 0;
}

function stopCmd(argv: string[], kill: boolean): number {
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, options: { force: { type: 'boolean' }, cwd: { type: 'string' } } }); } catch (e) { console.error(`cedia: ${(e as Error).message}`); return 2; }
  const id = parsed.positionals[0];
  if (!id) { console.error('usage: cedia stop|kill <id> [--force]'); return 2; }
  const home = cediaHome();
  const cwd = parsed.values.cwd ?? process.cwd();
  const slug = projectKey(cwd);
  const sessions = listBgSessions(home, slug);
  const s = sessions.find((x) => x.id === id);
  if (!s) { console.error(`no session ${id}`); return 1; }
  try {
    process.kill(s.pid, kill ? 'SIGKILL' : 'SIGTERM');
  } catch {}
  // wait briefly
  const start = Date.now();
  while (Date.now() - start < 2000 && isAlive(s.pid)) { /* busy wait small */ }
  if (isAlive(s.pid)) {
    try { process.kill(s.pid, 'SIGKILL'); } catch {}
  }
  recordStop(home, slug, id);
  console.log(`${kill ? 'killed' : 'stopped'} ${id}`);
  return 0;
}

function respawnCmd(argv: string[]): number {
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, options: { all: { type: 'boolean' }, cwd: { type: 'string' } } }); } catch (e) { console.error(`cedia: ${(e as Error).message}`); return 2; }
  const home = cediaHome();
  const cwd = parsed.values.cwd ?? process.cwd();
  const slug = projectKey(cwd);
  let ids = parsed.positionals;
  if (parsed.values.all) ids = listBgSessions(home, slug).map((s) => s.id);
  if (!ids.length) { console.error('usage: cedia respawn <id|--all>'); return 2; }
  for (const id of ids) {
    const sessions = listBgSessions(home, slug);
    const s = sessions.find((x) => x.id === id);
    if (!s) { console.error(`no session ${id}`); continue; }
    const child = Bun.spawn(selfSpawnArgs(['-p', 'respawn', '--thread', s.thread]), { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    try { child.unref(); } catch {}
    const bgid = `bg-${crypto.randomUUID().slice(0, 8)}`;
    recordStart(home, slug, { id: bgid, thread: s.thread, pid: child.pid ?? 0, logPath: s.logPath });
    console.log(`respawned ${id} as ${bgid}`);
  }
  return 0;
}

function outputStyle(argv: string[]): number {
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' }, cwd: { type: 'string' } } }); } catch (e) { console.error(`cedia: ${(e as Error).message}`); return 2; }
  const home = cediaHome();
  const styles = loadOutputStyles(home);
  const [name] = parsed.positionals;
  if (name) {
    const s = getStyle(name, home);
    if (!s) { console.error(`unknown style ${name}`); return 1; }
    // persist to settings
    const settingsPath = join(home, 'settings.json');
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
    settings.outputStyle = name;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\\n');
    console.log(parsed.values.json ? JSON.stringify(s) : `switched to ${name}`);
    return 0;
  }
  if (parsed.values.json) console.log(JSON.stringify(styles));
  else console.log(styles.map((s) => `${s.name}  ${s.description}`).join('\\n'));
  return 0;
}

function onboarding(argv: string[]): number {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: { json: { type: 'boolean' }, accept: { type: 'boolean' }, step: { type: 'string' } } }); } catch (e) { console.error(`cedia: ${(e as Error).message}`); return 2; }
  const home = cediaHome();
  if (parsed.values.accept) { acceptTrust(home); console.log('trust accepted'); return 0; }
  if (parsed.values.step) { markStep(parsed.values.step, home); console.log(`marked ${parsed.values.step}`); return 0; }
  const s = loadOnboarding(home);
  if (parsed.values.json) console.log(JSON.stringify({ ...s, complete: isComplete(home) }));
  else console.log(`completed: ${s.completed.join(', ') || '(none)'}; trust: ${s.hasTrustDialogAccepted ? 'accepted' : 'pending'}; complete: ${isComplete(home)}`);
  return 0;
}

async function remoteCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === 'list' || !sub) {
    const sessions = await listRemoteSessions();
    if (sessions.length === 0) { console.log('no remote sessions (set CEDIA_REMOTE_URL)'); return 0; }
    for (const s of sessions) console.log(`${s.id}  ${s.title ?? ''}`);
    return 0;
  }
  if (sub === 'run') {
    const prompt = rest.join(' ').trim();
    if (!prompt) { console.error('usage: cedia remote run <prompt>'); return 2; }
    console.log(await runRemote(prompt));
    return 0;
  }
  console.error('usage: cedia remote [list|run <prompt>]');
  return 2;
}

async function voiceCmd(argv: string[]): Promise<number> {
  let seconds = 5;
  const i = argv.indexOf('--seconds');
  if (i >= 0 && argv[i + 1]) seconds = Number(argv[i + 1]);
  console.log(`recording ${seconds}s…`);
  const r = await voiceInput(seconds);
  if (r.error) { console.error(r.error); return 1; }
  console.log(r.text);
  return 0;
}

async function mdmCmd(argv: string[]): Promise<number> {
  const [sub] = argv;
  if (sub === 'sync' || !sub) {
    const data = await fetchMdmSettings();
    if (!Object.keys(data).length) { console.log('no MDM data (set CEDIA_MDM_URL)'); return 0; }
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(cediaHome(), 'mdm-cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'managed-settings.json'), JSON.stringify(data, null, 2) + '\n');
    console.log('synced MDM settings');
    return 0;
  }
  console.error('usage: cedia mdm [sync]');
  return 2;
}

async function serveCmd(argv: string[]): Promise<number> {
  let port = 8787;
  const i = argv.indexOf('--port');
  if (i >= 0 && argv[i + 1]) port = Number(argv[i + 1]);
  const { runHeadless } = await import('./clients/headless/main.ts');
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/sessions') {
        return new Response(JSON.stringify({ sessions: [] }), { headers: { 'content-type': 'application/json' } });
      }
      if (req.method === 'POST' && url.pathname === '/run') {
        try {
          const body = (await req.json()) as { prompt?: string };
          const prompt = body.prompt ?? '';
          let out = '';
          const result = await runHeadless({ cwd: process.cwd(), prompt, outputFormat: 'json', permission: 'workspace', sandbox: 'off' }, (s) => { out += s; });
          return new Response(JSON.stringify({ output: result.result ?? out, thread: result.thread }), { headers: { 'content-type': 'application/json' } });
        } catch (e) {
          return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'content-type': 'application/json' } });
        }
      }
      return new Response('not found', { status: 404 });
    },
  });
  console.log(`cedia serve on http://127.0.0.1:${server.port}`);
  // keep alive
  await new Promise(() => {});
  return 0;
}

async function teleportCmd(argv: string[]): Promise<number> {
  const id = argv[0];
  if (!id) { console.error('usage: cedia teleport <session-id>'); return 2; }
  const remote = await fetchRemoteSession(id);
  if (!remote) { console.error('session not found (set CEDIA_REMOTE_URL)'); return 1; }
  const { ThreadStore, threadsDir } = await import('./core/project/threads.ts');
  const { projectKey } = await import('./core/session/log.ts');
  const store = new ThreadStore(threadsDir(cediaHome(), projectKey(process.cwd())));
  const tid = store.open(remote.title ?? `teleported ${id}`, { title: remote.title });
  console.log(`teleported ${id} -> ${tid}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

function teamsCmd(argv: string[]): number {
  const home = cediaHome();
  const store = new TeamStore(home);
  const [sub, ...rest] = argv;
  if (!sub || sub === 'list') {
    const teams = store.list();
    if (teams.length === 0) { console.log('no teams'); return 0; }
    for (const t of teams) console.log(teamLine(t));
    return 0;
  }
  if (sub === 'create') {
    const name = rest.join(' ').trim();
    if (!name) { console.error('usage: cedia teams create <name>'); return 2; }
    const t = store.create(name);
    console.log(`created ${t.id}: ${t.name}`);
    return 0;
  }
  if (sub === 'show') {
    const t = store.get(rest[0] ?? '');
    if (!t) { console.error('no such team'); return 1; }
    console.log(JSON.stringify(t, null, 2));
    return 0;
  }
  if (sub === 'add-task') {
    const [id, ...titleParts] = rest;
    const title = titleParts.join(' ').trim();
    if (!id || !title) { console.error('usage: cedia teams add-task <team> <title>'); return 2; }
    const task = store.addTask(id, title);
    if (!task) { console.error('no such team'); return 1; }
    console.log(`added ${task.id}: ${task.title}`);
    return 0;
  }
  if (sub === 'set-status') {
    const [id, taskId, status] = rest;
    if (!id || !taskId || !status) { console.error('usage: cedia teams set-status <team> <task> <status>'); return 2; }
    const t = store.updateTask(id, taskId, { status: status as 'pending' | 'in_progress' | 'done' | 'blocked' });
    if (!t) { console.error('no such team/task'); return 1; }
    console.log(`${t.id}: ${t.status}`);
    return 0;
  }
  if (sub === 'delete') {
    if (!rest[0] || !store.delete(rest[0])) { console.error('no such team'); return 1; }
    console.log('deleted');
    return 0;
  }
  console.error(`unknown subcommand: ${sub}`);
  return 2;
}

function magicDocsCmd(argv: string[]): number {
  const [sub, ...rest] = argv;
  const root = rest[0] || process.cwd();
  if (sub === 'list' || !sub) {
    const docs = findMagicDocs(root);
    if (docs.length === 0) { console.log('no magic docs'); return 0; }
    for (const d of docs) console.log(`${d.title}  ${d.path}`);
    return 0;
  }
  console.error('usage: cedia magic-docs [list] [root]');
  return 2;
}
