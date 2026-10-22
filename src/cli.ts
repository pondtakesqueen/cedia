import { parseArgs } from 'node:util';
import { runHeadless } from './clients/headless/main.ts';
import { ALIASES } from './core/providers/catalog.ts';
import { GUARDS } from './core/safety/policy.ts';
import { cediaHome } from './core/config.ts';
import { threadLine, threadsDir, ThreadStore, type Rating } from './core/project/threads.ts';
import { lintSession } from './core/session/lint.ts';
import { projectKey, SessionLog } from './core/session/log.ts';
import { EFFORTS, type Effort } from './core/types.ts';
import { versionInfo } from './protocol/version.ts';

const USAGE = `usage: cedia -p "<prompt>" [options]   (prompt may also come on stdin)
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
      --permission <mode>      auto | read-only | workspace (default: $CEDIA_PERMISSION, ~/.cedia/settings.json, auto).
                               auto is workspace when the sandbox is on, read-only when it is off. cedia never stops to ask for permission
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
      --spawn <on|off>         let the writer hand self-contained work to sub-threads (default: settings, on)
      --ask <on|off>           give the writer ask_user, to end the run with one question for you when only you can
                               decide; the thread waits as 'asking' and your answer is its next prompt
                               (default: settings ask, off)
      --swarm <ref>            the model explore sub-threads run on (default: roles.swarm in settings, beam)
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
       cedia threads [--all] [--cwd <dir>]  list this project's threads (--all: archived ones too)
       cedia threads show <id>              a thread's task, state, sessions, handoff note, result and messages
       cedia threads send <id> <text>       leave a message the thread sees at its next turn; prints the message id
       cedia threads unsend <id> [<msg>...] take back your messages it has not seen yet (all of them by default)
       cedia threads rate <id> <up|down> [--session <sid>] [--note <text>]
                                            rate an answer (default: the thread's latest) for picking eval cases;
                                            no model ever sees it
       cedia threads archive|unarchive <id> hide a thread from the list, or bring it back

models: ${Object.keys(ALIASES).join(', ')}`;

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === '--version' || argv[0] === '-v') {
    const info = versionInfo();
    console.log(argv.slice(1).includes('--json') ? JSON.stringify(info) : `cedia ${info.version}`);
    return 0;
  }
  if (argv[0] === 'lint-session') return lintFiles(argv.slice(1));
  if (argv[0] === 'threads') return threads(argv.slice(1));
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
      ask: { type: 'string' },
      swarm: { type: 'string' },
      'handoff-at': { type: 'string' },
      handoff: { type: 'string' },
      review: { type: 'string' },
      goal: { type: 'string' },
      'goal-judge': { type: 'string' },
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
  let prompt = values.print ?? positionals.join(' ');
  if (!prompt && !process.stdin.isTTY) prompt = (await new Response(Bun.stdin.stream()).text()).trim();
  if (!prompt) {
    console.error(USAGE);
    return 2;
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
  try {
    const result = await runHeadless({
      prompt,
      ...(values.model ? { model: values.model } : {}),
      cwd: values.cwd ?? process.cwd(),
      outputFormat: format,
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
      ...(values.ask ? { ask: values.ask } : {}),
      ...(values.swarm ? { swarm: values.swarm } : {}),
      ...(values['handoff-at'] ? { handoffAt: values['handoff-at'] } : {}),
      ...(values.handoff ? { handoff: values.handoff } : {}),
      ...(values.review ? { review: values.review } : {}),
      ...(values.goal ? { goal: values.goal } : {}),
      ...(values['goal-judge'] ? { goalJudge: values['goal-judge'] } : {}),
      ...(values.plan ? { plan: values.plan } : {}),
      ...(values.check ? { checks: values.check } : {}),
      ...(values.sandbox ? { sandbox: values.sandbox } : {}),
      ...(values['allow-domain'] ? { allowDomains: values['allow-domain'] } : {}),
    });
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

function threads(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { cwd: { type: 'string' }, all: { type: 'boolean' }, session: { type: 'string' }, note: { type: 'string' } },
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
      const lines = [`${t.id}  ${t.state}  ${t.title}`, '', t.task, ''];
      for (const s of t.sessions) lines.push(`session ${s.sessionId}  ${s.model}  ${s.why}${s.path ? `  ${s.path}` : ''}`);
      if (t.handoff) lines.push('', `handoff from ${t.handoff.sessionId}:`, t.handoff.note);
      if (t.result) lines.push('', 'result:', t.result);
      for (const m of t.messages) lines.push('', `message ${m.id} from ${m.from} at ${m.at}${m.unsent ? ' (unsent)' : t.pending.includes(m) ? ' (not seen yet)' : ''}:`, m.text);
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
    if (cmd === 'rate' && id && rest.length === 1) {
      store.rate(id, rest[0] as Rating, { ...(values.session ? { sessionId: values.session } : {}), ...(values.note ? { note: values.note } : {}) });
      console.log(`rated ${id} ${rest[0]}`);
      return 0;
    }
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 1;
  }
  console.error('usage: cedia threads [list [--all] | show <id> | send <id> <text> | unsend <id> [<msg>...] | rate <id> <up|down> [--session <sid>] [--note <text>] | archive <id> | unarchive <id>] [--cwd <dir>]');
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
