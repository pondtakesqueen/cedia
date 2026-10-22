import { CombinedAutocompleteProvider, Container, Editor, Markdown, ProcessTerminal, Text, TUI, matchesKey, truncateToWidth, type Component, type MarkdownTheme, type Terminal } from '@mariozechner/pi-tui';
import { cediaHome, loadRoles } from '../../core/config.ts';
import { gitStatus, statusText, workingDiff } from '../../core/project/git.ts';
import { threadLine, threadsDir, ThreadStore } from '../../core/project/threads.ts';
import { restoredText, restoreTurn, sinceTurn, threadTurn } from '../../core/project/undo.ts';
import { workspaceSnapshots } from '../../core/safety/snapshot.ts';
import { projectKey } from '../../core/session/log.ts';
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
  { name: 'new', description: 'start a new thread' },
  { name: 'thread', description: 'go on with a thread of this project: /thread <id>, or list them' },
  { name: 'model', description: 'the model the next turn runs on: /model <ref>' },
  { name: 'help', description: 'these commands and keys' },
  { name: 'quit', description: 'leave (Ctrl+D)' },
];

const MAX_DIFF_LINES = 400;

// One line for a call: what it acts on.
export function callLine(tool: string, input: JsonObject): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  const what = s('command') ?? s('path') ?? s('pattern') ?? s('task') ?? JSON.stringify(input);
  const one = what.split('\n')[0]!;
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
  private running: { stop: AbortController; done: Promise<void> } | undefined;
  private spent = 0;
  private context = 0;
  // The text block the stream is writing into, if any.
  private live: { md: Markdown; text: string } | undefined;
  private streamed = false;
  private readonly store: ThreadStore;
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
      else this.quit();
      return { consume: true };
    }
    if (matchesKey(data, 'ctrl+d') && !this.editor.getText()) {
      this.quit();
      return { consume: true };
    }
    return undefined;
  }

  private quit() {
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
      this.context ? `ctx ${Math.round(this.context / 1000)}k` : '',
      this.spent ? `$${this.spent.toFixed(4)}` : '',
      this.running ? 'working' : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  private refreshStatus(git = false) {
    if (git) {
      const g = gitStatus(this.args.cwd);
      this.git = g && statusText(g);
    }
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
        if (line.trim()) this.onMessage(decode<CoreMessage>(line));
      }
    };
    try {
      const result = await this.run(
        { ...this.args, prompt, outputFormat: 'stream-json', ...(this.model ? { model: this.model } : {}), ...(this.thread ? { thread: this.thread } : {}), note: (t) => this.say(yellow(t.trimEnd())), signal },
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
        this.live.md.setText(this.live.text);
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
        if (!this.streamed) for (const b of e.blocks) if (b.type === 'text' && b.text.trim()) this.chat.addChild(new Markdown(b.text, 0, 0, MARKDOWN));
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
        const lines = e.output.text.split('\n');
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
          return this.quit();
        case 'diff':
          return this.diff();
        case 'undo':
        case 'redo':
          return this.restore(name, rest[0] === 'force');
        case 'new':
          this.thread = undefined;
          this.context = 0;
          this.say(dim('the next prompt starts a new thread'));
          break;
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

  private restore(action: 'undo' | 'redo', force: boolean) {
    if (this.running) return this.say(yellow(`a turn is running: stop it before /${action}`));
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
