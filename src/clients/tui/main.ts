import { CombinedAutocompleteProvider, Container, Editor, Markdown, ProcessTerminal, Text, TUI, matchesKey, truncateToWidth, type Component, type MarkdownTheme, type Terminal } from '@mariozechner/pi-tui';
import { readFileSync } from 'node:fs';
import { cediaHome, loadPrivacy, loadRoles } from '../../core/config.ts';
import { COMMIT_SYSTEM, commitFiles, commitMessage, commitPatch, commitPrompt, currentBranch, defaultBranch, prBlocked, pushAndOpenPr, recentSubjects, threadChanges } from '../../core/project/commit.ts';
import { runPrompt } from '../../core/loop/run.ts';
import { resolveModel } from '../../core/providers/catalog.ts';
import { providerFor } from '../../core/providers/index.ts';
import { gitStatusAsync, statusText, workingDiff } from '../../core/project/git.ts';
import { threadLine, threadsDir, ThreadStore } from '../../core/project/threads.ts';
import { restoredText, restoreTurn, sinceTurn, threadTurn } from '../../core/project/undo.ts';
import { workspaceSnapshots } from '../../core/safety/snapshot.ts';
import { projectKey, SessionLog, sessionPath } from '../../core/session/log.ts';
import type { HeadlessResult, JsonObject, SessionEvent } from '../../core/types.ts';
import { decode, type CoreMessage } from '../../protocol/index.ts';
import { receipt, runHeadless, type HeadlessArgs } from '../headless/main.ts';

// The interactive client. Each prompt is one headless run of the current thread (`--thread`), streamed as
// stream-json and drawn as it arrives, so the TUI takes the path `-p` and the evals take: the same session goes on
// while the model stays the same, and every turn is in the thread's logs. The commands work on the thread's files
// through the core: /diff, /undo and /redo (core/project/undo.ts), the status line from git (core/project/git.ts).

export type TuiArgs = Omit<HeadlessArgs, 'prompt' | 'outputFormat' | 'note' | 'signal'>;

const esc = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const dim = esc('2');
const red = esc('31');
const green = esc('32');
const yellow = esc('33');
const cyan = esc('36');
const bold = esc('1');

const MARKDOWN: MarkdownTheme = {
  heading: bold,
  link: cyan,
  linkUrl: dim,
  code: cyan,
  codeBlock: (s) => s,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic: esc('3'),
  strikethrough: esc('9'),
  underline: esc('4'),
};
const SELECT = { selectedPrefix: cyan, selectedText: cyan, description: dim, scrollInfo: dim, noMatch: dim };

export const COMMANDS: { name: string; description: string }[] = [
  { name: 'diff', description: 'working tree changes, and what changed since the last turn started' },
  { name: 'undo', description: "put back the files the last turn changed ('/undo force' takes files changed since too)" },
  { name: 'redo', description: 'put them forward again' },
  { name: 'commit', description: "commit the files this thread changed, with a message a model writes and you confirm ('/commit <message>' writes your own)" },
  { name: 'pr', description: 'push this branch and open a pull request through gh (never from the default branch); asks first' },
  { name: 'new', description: 'start a new thread' },
  { name: 'thread', description: 'go on with a thread of this project: /thread <id>, or list them' },
  { name: 'model', description: 'the model the next turn runs on: /model <ref>' },
  { name: 'goal', description: "keep each turn going until a separate judge finds this holds: /goal <condition>; '/goal off' ends it" },
  { name: 'help', description: 'these commands and keys' },
  { name: 'quit', description: 'leave (Ctrl+D)' },
];

const MAX_DIFF_LINES = 400;

// Text from a command or the model, with the escapes and control characters that would move the cursor or
// restyle the screen taken out (newlines and tabs stay).
export const printable = (s: string) =>
  s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -\/]*[0-~]?|[\x00-\x08\x0b-\x1f\x7f\x9b]/g, '');

// One line for a call: what it acts on.
export function callLine(tool: string, input: JsonObject): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  const what = s('command') ?? s('path') ?? s('pattern') ?? s('task') ?? JSON.stringify(input);
  const one = printable(what.split('\n')[0]!);
  return `${tool} ${one.length > 160 ? `${one.slice(0, 157)}...` : one}${what.includes('\n') ? ' …' : ''}`;
}

const colorPatch = (patch: string) =>
  patch.split('\n').map((l) => (l.startsWith('+++') || l.startsWith('---') ? bold(l) : l.startsWith('+') ? green(l) : l.startsWith('-') ? red(l) : l.startsWith('@@') ? cyan(l) : l));

// One line under the editor, cut to the terminal's width.
class StatusLine implements Component {
  text = '';
  setText(text: string) {
    this.text = text;
  }
  render(width: number): string[] {
    return [truncateToWidth(this.text, width)];
  }
  invalidate() {}
}

export class CediaTui {
  readonly tui: TUI;
  readonly chat = new Container();
  readonly status = new StatusLine();
  readonly editor: Editor;
  thread: string | undefined;
  model: string | undefined;
  // The condition every turn runs under until it is cleared (--goal, /goal): a judge decides when a turn is done.
  goal: string | undefined;
  private running: { stop: AbortController; done: Promise<void> } | undefined;
  private spent = 0;
  private context = 0;
  // The text block the stream is writing into, if any.
  private live: { md: Markdown; text: string } | undefined;
  private streamed = false;
  private readonly store: ThreadStore;
  // A step waiting for the user's yes (a commit, a push): the next line answers it.
  private pending: { what: string; yes: (signal: AbortSignal) => Promise<void> | void } | undefined;
  // Read again when files may have changed (a call's snapshot, the end of a turn, a command), not on every event.
  private git: string | undefined;

  constructor(
    readonly args: TuiArgs,
    terminal: Terminal = new ProcessTerminal(),
    private readonly run: typeof runHeadless = runHeadless,
    private readonly exit: () => void = () => process.exit(0),
  ) {
    this.thread = args.thread;
    this.model = args.model;
    this.goal = args.goal;
    this.store = new ThreadStore(threadsDir(cediaHome(), projectKey(args.cwd)));
    this.tui = new TUI(terminal);
    this.editor = new Editor(this.tui, { borderColor: dim, selectList: SELECT });
    this.editor.onSubmit = (text) => this.submit(text);
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, args.cwd));
    this.tui.addChild(this.chat);
    this.tui.addChild(this.editor);
    this.tui.addChild(this.status);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => this.key(data));
  }

  start() {
    this.say(dim(`cedia in ${this.args.cwd}. /help for commands; Esc or Ctrl+C stops a turn.`));
    this.refreshStatus(true);
    this.tui.start();
  }

  stop() {
    this.running?.stop.abort();
    this.tui.stop();
  }

  // Resolves once the turn in progress, if any, has ended.
  async idle(): Promise<void> {
    await this.running?.done;
  }

  // Ctrl+C or Esc stops a turn; with none running, Ctrl+C clears the editor, then leaves, and Ctrl+D leaves.
  private key(data: string): { consume: boolean } | undefined {
    if (this.running && (matchesKey(data, 'ctrl+c') || matchesKey(data, 'escape'))) {
      this.running.stop.abort();
      this.say(yellow('stopping…'));
      return { consume: true };
    }
    if (matchesKey(data, 'ctrl+c')) {
      if (this.editor.getText()) this.editor.setText('');
      else void this.quit();
      return { consume: true };
    }
    if (matchesKey(data, 'ctrl+d') && !this.editor.getText()) {
      void this.quit();
      return { consume: true };
    }
    return undefined;
  }

  // A turn in progress is stopped and given a moment to close its sandbox and finish its logs.
  private async quit() {
    this.running?.stop.abort();
    await Promise.race([this.idle(), Bun.sleep(5000)]);
    this.stop();
    this.exit();
  }

  say(text: string) {
    this.chat.addChild(new Text(text, 0, 0));
    this.tui.requestRender();
  }

  statusLine(): string {
    return [
      this.model ?? loadRoles({}).code.ref,
      this.args.permission ?? 'auto',
      this.git,
      this.thread ?? 'new thread',
      this.goal ? 'goal' : '',
      this.context ? `ctx ${Math.round(this.context / 1000)}k` : '',
      this.spent ? `$${this.spent.toFixed(4)}` : '',
      this.running ? 'working' : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  // Git is read in the background, at most one read at a time, with one more queued when asked meanwhile: the
  // core's events arrive inside its own calls, so a slow `git status` must not hold them up.
  private gitReading: 'idle' | 'reading' | 'again' = 'idle';
  private readGit() {
    if (this.gitReading !== 'idle') {
      this.gitReading = 'again';
      return;
    }
    this.gitReading = 'reading';
    void gitStatusAsync(this.args.cwd).then((g) => {
      this.git = g && statusText(g);
      const again = this.gitReading === 'again';
      this.gitReading = 'idle';
      this.refreshStatus();
      if (again) this.readGit();
    });
  }

  // Resolves once the git read in progress, if any, has landed (for tests).
  async settled(): Promise<void> {
    while (this.gitReading !== 'idle') await Bun.sleep(5);
  }

  private refreshStatus(git = false) {
    if (git) this.readGit();
    try {
      this.status.setText(dim(this.statusLine()));
    } catch (e) {
      this.status.setText(red(`status: ${(e as Error).message}`));
    }
    this.tui.requestRender();
  }

  submit(raw: string) {
    const text = raw.trim();
    if (!text) return;
    this.editor.addToHistory(text);
    this.editor.setText('');
    if (this.pending) {
      const p = this.pending;
      this.pending = undefined;
      if (/^(y|yes)$/i.test(text)) return void this.busy((signal) => p.yes(signal));
      this.say(dim(`not done: ${p.what}`));
      // A plain no ends there; anything else is the next prompt or command as well.
      if (/^(n|no)$/i.test(text)) return;
    }
    if (text.startsWith('/')) return this.command(text.slice(1));
    if (this.running) {
      this.say(yellow('a turn is running: wait for it, or stop it with Esc'));
      return;
    }
    this.chat.addChild(new Text(bold(`› ${text}`), 0, 1));
    const stop = new AbortController();
    const done = this.turn(text, stop.signal).finally(() => {
      this.running = undefined;
      this.refreshStatus(true);
    });
    this.running = { stop, done };
    this.refreshStatus();
  }

  private async turn(prompt: string, signal: AbortSignal) {
    let buffer = '';
    const out = (chunk: string) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          this.onMessage(decode<CoreMessage>(line));
        } catch (e) {
          this.say(red(`could not show a line of the run: ${(e as Error).message}`));
        }
      }
    };
    const { goal: _, ...args } = this.args;
    try {
      const result = await this.run(
        { ...args, ...(this.goal ? { goal: this.goal } : {}), prompt, outputFormat: 'stream-json', ...(this.model ? { model: this.model } : {}), ...(this.thread ? { thread: this.thread } : {}), note: (t) => this.say(yellow(t.trimEnd())), signal },
        out,
      );
      this.done(result);
    } catch (e) {
      this.say(red(`cedia: ${(e as Error).message}`));
    }
  }

  private onMessage(m: CoreMessage) {
    if (m.type === 'stream') {
      const e = m.event;
      if (e.type === 'text_start') {
        this.live = { md: new Markdown('', 0, 0, MARKDOWN), text: '' };
        this.chat.addChild(this.live.md);
        this.streamed = true;
      } else if (e.type === 'text_delta' && this.live) {
        this.live.text += e.delta;
        this.live.md.setText(printable(this.live.text));
      } else if (e.type === 'text_end') this.live = undefined;
      else if (e.type === 'thinking_start') this.say(dim('thinking…'));
      this.tui.requestRender();
      return;
    }
    if (m.type === 'event') return this.onEvent(m.event);
  }

  private onEvent(e: SessionEvent) {
    switch (e.kind) {
      case 'request':
        this.streamed = false;
        break;
      case 'assistant': {
        // A reply that did not stream (a scripted model, a retry) is drawn whole.
        if (!this.streamed) for (const b of e.blocks) if (b.type === 'text' && b.text.trim()) this.chat.addChild(new Markdown(printable(b.text), 0, 0, MARKDOWN));
        const u = e.usage;
        this.context = u.uncached + u.cacheRead + u.cacheWrite + u.output;
        break;
      }
      case 'tool_intent':
        this.say(cyan(`● ${callLine(e.tool, e.input)}`));
        break;
      case 'permission':
        if (e.decision === 'deny') this.say(red(`✗ ${e.tool} denied by ${e.rule}${e.reason ? `: ${e.reason}` : ''}`));
        break;
      case 'tool_result': {
        const lines = printable(e.output.text).split('\n');
        const first = lines.find((l) => l.trim()) ?? '';
        const more = lines.length > 1 ? dim(` (+${lines.length - 1} lines)`) : '';
        const head = `  ⎿ ${e.status === 'completed' ? '' : `${e.status}: `}${first.length > 160 ? `${first.slice(0, 157)}...` : first}`;
        this.say((e.output.isError ? red(head) : dim(head)) + more);
        break;
      }
      case 'snapshot':
        if (e.changed.length) this.say(dim(`  changed ${e.changed.join(', ')}`));
        return this.refreshStatus(true);
    }
    this.refreshStatus();
  }

  private done(r: HeadlessResult) {
    this.thread = r.thread ?? this.thread;
    this.spent += r.costUsd;
    const parts = [r.subtype === 'success' ? 'done' : r.subtype, `${r.numTurns} turn${r.numTurns === 1 ? '' : 's'}`, `$${r.costUsd.toFixed(4)}`, `cache ${Math.round(r.cacheHitRatio * 100)}%`];
    this.say(dim(parts.join(' · ')));
    if (r.evidence) this.say(dim(receipt(r.evidence, r.thread)));
    if (r.goal) {
      const n = `${r.goal.rounds.length} judgement${r.goal.rounds.length === 1 ? '' : 's'}`;
      const why = r.goal.rounds.at(-1)?.reason.split('\n')[0];
      if (r.goal.verdict === 'met') this.say(green(`goal met after ${n}`));
      else this.say(yellow(`goal ${r.goal.verdict.replace('_', ' ')} after ${n}${why ? `: ${printable(why)}` : ''}`));
    }
    // The thread waits on the owner: what is typed next is the answer.
    if (r.question) this.say(yellow([printable(r.question.question), ...(r.question.options ?? []).map((o, i) => `  ${i + 1}. ${printable(o)}`), 'your next message is the answer'].join('\n')));
  }

  command(line: string) {
    const [name = '', ...rest] = line.trim().split(/\s+/);
    try {
      switch (name) {
        case 'help':
          this.say([...COMMANDS.map((c) => `/${c.name}  ${dim(c.description)}`), dim('Enter sends; Shift+Enter or Alt+Enter is a new line; Esc or Ctrl+C stops a turn; Ctrl+D leaves')].join('\n'));
          return;
        case 'quit':
        case 'exit':
          return void this.quit();
      }
      // The rest read or change what a turn works on, so they wait for it.
      if (this.running && COMMANDS.some((c) => c.name === name)) return this.say(yellow(`a turn is running: stop it (Esc) before /${name}`));
      switch (name) {
        case 'diff':
          return this.diff();
        case 'undo':
        case 'redo':
          return this.restore(name, rest[0] === 'force');
        case 'commit':
          // The message as typed, new lines included.
          return void this.busy((signal) => this.commit(line.trim().slice(name.length), signal));
        case 'pr':
          return this.pr();
        case 'new':
          this.thread = undefined;
          this.context = 0;
          this.say(dim(`the next prompt starts a new thread${this.goal ? '; the goal still holds (/goal off ends it)' : ''}`));
          break;
        case 'goal': {
          // The condition as typed, new lines included.
          const condition = line.trim().slice(name.length).trim();
          if (!condition) this.say(this.goal ? `${dim('each turn goes on until a judge finds this holds:')}\n${printable(this.goal)}` : dim('no goal: /goal <condition> sets one'));
          else if (condition === 'off') {
            this.say(dim(this.goal ? 'goal ended: a turn is done when the done gate passes' : 'no goal to end'));
            this.goal = undefined;
          } else {
            this.goal = condition;
            this.say(dim('from the next turn on, a separate judge checks this after each claim of done, and sends the writer back (at most 3 times) while it does not hold'));
          }
          break;
        }
        case 'thread':
          if (!rest[0]) this.say(this.store.list().filter((t) => !t.archived).map(threadLine).join('\n') || dim('no threads in this project'));
          else if (!this.store.has(rest[0])) this.say(red(`no thread ${rest[0]} in this project`));
          else {
            this.thread = rest[0];
            this.context = 0;
            this.say(dim(`going on with ${threadLine(this.store.read(rest[0]))}`));
          }
          break;
        case 'model':
          if (!rest[0]) this.say(dim(`the next turn runs on ${this.model ?? loadRoles({}).code.ref}`));
          else {
            this.model = loadRoles({ code: rest[0] }).code.ref;
            this.say(dim(`the next turn runs on ${this.model}; a thread whose last session used another model goes on in a new session`));
          }
          break;
        default:
          this.say(red(`unknown command /${name}; /help lists them`));
      }
    } catch (e) {
      this.say(red((e as Error).message));
    }
    this.refreshStatus(true);
  }

  private diff() {
    const w = workingDiff(this.args.cwd);
    const lines: string[] = [];
    if (!w) lines.push(dim('not a git repository'));
    else {
      lines.push(bold('working tree against HEAD'));
      if (!w.patch && !w.untracked.length) lines.push(dim('  no changes'));
      lines.push(...colorPatch(w.patch.trimEnd()).filter((l) => l !== ''));
      if (w.untracked.length) lines.push(dim(`untracked: ${w.untracked.join(', ')}`));
    }
    const change = this.thread ? threadTurn(this.store, this.thread) : undefined;
    const snaps = change && workspaceSnapshots(change.cwd, cediaHome());
    if (change && snaps) {
      const patch = sinceTurn(snaps, change);
      lines.push('', bold("since this thread's last turn started"), ...(patch ? colorPatch(patch.trimEnd()) : [dim('  no changes')]));
    }
    const cut = lines.length - MAX_DIFF_LINES;
    this.say((cut > 0 ? [...lines.slice(0, MAX_DIFF_LINES), dim(`[${cut} more lines: run git diff]`)] : lines).join('\n'));
  }

  // Work that is not a turn but must not overlap one (a commit message, a push): shown as running meanwhile.
  private async busy(work: (signal: AbortSignal) => Promise<void> | void) {
    const stop = new AbortController();
    let release = () => {};
    this.running = { stop, done: new Promise<void>((r) => (release = r)) };
    this.refreshStatus();
    try {
      await work(stop.signal);
    } catch (e) {
      this.say(red((e as Error).message));
    } finally {
      this.running = undefined;
      this.refreshStatus(true);
      release();
    }
  }

  // The message comes from the next turn's model, in a session of its own with no tools, logged like any other.
  private async draftMessage(prompt: string, signal: AbortSignal): Promise<string> {
    const model = resolveModel(this.model ?? loadRoles({}).code.ref);
    const fauxScript = process.env.CEDIA_FAUX_SCRIPT ? JSON.parse(readFileSync(process.env.CEDIA_FAUX_SCRIPT, 'utf8')) : undefined;
    const id = crypto.randomUUID();
    const log = SessionLog.create({ id, path: sessionPath(this.args.cwd, id) });
    const r = await runPrompt({ log, provider: providerFor(model, { fauxScript }), model, tools: [], system: COMMIT_SYSTEM, cwd: this.args.cwd, role: 'commit', privacy: loadPrivacy(this.args.cwd, this.args.privacy), maxTurns: 2, signal }, prompt);
    this.spent += r.costUsd;
    if (r.subtype !== 'success') throw new Error(`the commit message could not be written (${r.subtype}): write one with /commit <message>`);
    return commitMessage(r.result);
  }

  private async commit(own: string, signal: AbortSignal) {
    if (!this.thread) return this.say(dim('no thread yet: nothing to commit'));
    const snaps = workspaceSnapshots(this.args.cwd, cediaHome());
    if (!snaps) return this.say(red('no snapshots for this directory, so cedia cannot tell which files the thread changed'));
    const files = threadChanges(this.store, this.thread, this.args.cwd, snaps);
    if (!files.length) return this.say(dim('nothing this thread changed differs from HEAD'));
    const message = own.trim() || (await this.draftMessage(commitPrompt(commitPatch(this.args.cwd, files), files, recentSubjects(this.args.cwd)), signal));
    if (!message) return this.say(red('the message came back empty: write one with /commit <message>'));
    this.say([bold(`commit ${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`), '', message, '', yellow('commit this? y to commit; n, or anything else you type, cancels')].join('\n'));
    this.pending = {
      what: 'the commit',
      yes: () => {
        const r = commitFiles(this.args.cwd, files, message);
        this.say(r.ok ? green(r.out.split('\n')[0] ?? 'committed') : red(`git commit failed: ${r.out}`));
      },
    };
  }

  private pr() {
    const blocked = prBlocked(this.args.cwd);
    if (blocked) return this.say(red(blocked));
    const branch = currentBranch(this.args.cwd)!;
    const base = defaultBranch(this.args.cwd);
    this.say(yellow(`push ${branch} to origin and open a pull request${base ? ` into ${base}` : ''}? y to go on; n, or anything else you type, cancels`));
    this.pending = {
      what: 'the push',
      yes: async (signal) => {
        const r = await pushAndOpenPr(this.args.cwd, undefined, signal);
        this.say(r.ok ? green(r.out) : red(r.out));
      },
    };
  }

  private restore(action: 'undo' | 'redo', force: boolean) {
    if (!this.thread) return this.say(dim(`no thread yet: nothing to ${action}`));
    const r = restoreTurn(this.store, this.thread, (cwd) => workspaceSnapshots(cwd, cediaHome()), action, { force });
    this.say('error' in r ? red(r.error) : restoredText(r));
  }
}

export async function runTui(args: TuiArgs): Promise<number> {
  const app = new CediaTui(args);
  app.start();
  await new Promise<never>(() => {}); // the app leaves through quit()
  return 0;
}
