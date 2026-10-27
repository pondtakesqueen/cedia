import { CombinedAutocompleteProvider, Container, Editor, Markdown, ProcessTerminal, Text, TUI, matchesKey, truncateToWidth, SelectList, type SelectItem, type Component, type MarkdownTheme, type Terminal } from '@mariozechner/pi-tui';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cediaHome, isMode, loadPolicy, loadPrivacy, loadRoles, MODES } from '../../core/config.ts';
import { loadSkills } from '../../core/skills/skills.ts';
import { listMcp } from '../../core/mcp/manage.ts';
import { loadKeybindings, watchKeybindings } from './keybindings/loader.ts';
import { toggleVim, toInsert } from './vim/transitions.ts';
import { findCommand } from './keybindings/resolver.ts';
import { resolveBindings } from './keybindings/resolver.ts';
import { loadOutputStyles, loadOutputStyleSetting } from '../../core/output-styles/styles.ts';
import { versionInfo } from '../../protocol/version.ts';
import { modelList } from '../../core/providers/models.ts';
import { commitFiles, currentBranch, defaultBranch, prBlocked, pullRequest, pushAndOpenPr, threadChanges } from '../../core/project/commit.ts';
import { draftCommitMessage } from '../../core/project/draft.ts';
import { runPrompt } from '../../core/loop/run.ts';
import { resolveModel } from '../../core/providers/catalog.ts';
import { providerFor } from '../../core/providers/index.ts';
import { gitStatusAsync, statusText, workingDiff, type GitStatus } from '../../core/project/git.ts';
import { threadLine, threadsDir, ThreadStore } from '../../core/project/threads.ts';
import { restoredText, restoreTurn, sinceTurn, threadTurn } from '../../core/project/undo.ts';
import { rewindThread, rewoundText, runLines } from '../../core/project/rewind.ts';
import { forkThread } from '../../core/project/fork.ts';
import { workspaceSnapshots } from '../../core/safety/snapshot.ts';
import { systemFor } from '../../core/prompts.ts';
import { CORE_TOOLS } from '../../core/tools/index.ts';
import { askedReviewPrompt, fixPrompt, parseVerdict, type ReviewSubject } from '../../core/trust/review.ts';
import { projectKey, SessionLog, sessionPath } from '../../core/session/log.ts';
import { memoryPath, MemoryStore } from '../../core/project/memory.ts';
import type { HeadlessResult, JsonObject, SessionEvent } from '../../core/types.ts';
import { decode, type CoreMessage } from '../../protocol/index.ts';
import { receipt, runHeadless, type HeadlessArgs } from '../headless/main.ts';
import { CediaController } from './controller.ts';
import { loadTheme, palette } from './theme.ts';
import { fetchMdmSettings } from '../../core/project/mdm-remote.ts';
import { refreshLocalModelCache } from '../../core/providers/catalog.ts';
import { renderStatusBar } from './status-bar.ts';
import { renderOverlay, renderPermissionPrompt } from './overlays.ts';
import { bashDialog, editDialog, webFetchDialog, askUserDialog } from './permission-dialogs.ts';
import { renderToolCard, renderThinking, renderReceipt, renderUserMessage, renderAssistantMessage, renderSessionDivider } from './message-list.ts';
import { filterCommands, CommandPicker } from './command-picker.ts';
import { groupByProvider, ModelPicker } from './model-picker.ts';
import { PermissionPicker } from './permission-picker.ts';
import { SettingsScreen } from './settings-screen.ts';
import { loadOnboarding, isComplete, ONBOARDING_STEPS, acceptTrust, markStep } from './onboarding.ts';
import { runStatusLineCommand } from './statusline.ts';

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
  codeBlock: (s) => s.split('\n').map((line) => {
    const trimmed = line.trim();
    if (/^(#|\/\/|\/\*|\*|--|;)/.test(trimmed)) return dim(line);
    return line
      .replace(/("[^"]*"|'[^']*'|`[^`]*`)/g, cyan('$1'))
      .replace(/@(?:[A-Za-z_][\w.]*)/g, yellow('$&'))
      .replace(/\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|def|fn|pub|struct|enum|impl|type|interface|public|private|protected|static|new|this|true|false|null|undefined|void|any|string|number|boolean|never|unknown|readonly|extends|implements|default|switch|case|break|continue|try|catch|finally|throw|yield|in|of|as|is)\b/g, bold('$1'))
      .replace(/\b([A-Za-z_][\w]*)\s*(?=\()/g, (m) => bold(m))
      .replace(/\b(\d+(?:\.\d+)?)\b/g, yellow('$1'));
  }).join('\n'),
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
  { name: 'rewind', description: 'go back to before a run: /rewind lists runs, /rewind <n> rewinds (conversation and files)' },
  { name: 'commit', description: "commit the files this thread changed, with a message a model writes and you confirm ('/commit <message>' writes your own)" },
  { name: 'pr', description: 'push this branch and open a pull request through gh (never from the default branch); asks first' },
  { name: 'review', description: "a model reviews the uncommitted changes ('/review <n>' a pull request, through gh); findings come with evidence" },
  { name: 'plan', description: 'send this prompt to the planner first, whatever triage would say: /plan <prompt>' },
  { name: 'quick', description: 'send this prompt straight to the writer, with no plan: /quick <prompt>' },
  { name: 'new', description: 'start a new thread' },
  { name: 'memory', description: 'project memory: /memory lists, /memory <text> adds a note' },
  { name: 'skills', description: 'skills this session can load' },
  { name: 'mcp', description: 'MCP servers configured' },
  { name: 'fork', description: 'fork a thread: /fork <n|run|end> [--side]' },
  { name: 'thread', description: 'go on with a thread of this project: /thread <id>, or list them' },
  { name: 'model', description: 'the model the next turn runs on: /model <ref>' },
  { name: 'goal', description: "keep each turn going until a separate judge finds this holds: /goal <condition>; '/goal off' ends it" },
  { name: 'palette', description: 'command palette: pick a command' },
  { name: 'help', description: 'these commands and keys' },
  { name: 'settings', description: 'show the current settings' },
  { name: 'config', description: 'show ~/.cedia/settings.json' },
  { name: 'cost', description: 'spend, context tokens, and output rate' },
  { name: 'context', description: 'context window usage' },
  { name: 'status', description: 'the status line' },
  { name: 'clear', description: 'clear the chat view' },
  { name: 'transcript', description: 'show the full transcript of this thread' },
  { name: 'search', description: 'search the chat transcript: /search <term>' },
  { name: 'actions', description: 'message actions menu (copy, rewind, fork)' },
  { name: 'rename', description: 'rename this thread: /rename <title>' },
  { name: 'resume', description: 'go on with a thread: /resume <id> (lists them without an id)' },
  { name: 'color', description: 'alias for /theme' },
  { name: 'hooks', description: 'hooks configured in settings.json' },
  { name: 'effort', description: 'show or set the starting effort: /effort <level>' },
  { name: 'branch', description: 'git branches' },
  { name: 'copy', description: 'copy the last reply to the clipboard' },
  { name: 'tasks', description: 'sub-threads / task list for this thread' },
  { name: 'compact', description: 'show handoff/compaction status' },
  { name: 'fast', description: 'toggle fast mode' },
  { name: 'export', description: 'export this thread to a file: /export [path]' },
  { name: 'agents', description: 'sub-threads of this thread' },
  { name: 'btw', description: 'ask a side question without derailing the thread: /btw <question>' },
  { name: 'theme', description: 'the current theme' },
  { name: 'doctor', description: 'versions, settings, MCP, sandbox' },
  { name: 'permission', description: 'permission mode: /permission <mode>' },
  { name: 'vim', description: 'toggle vim mode' },
  { name: 'onboarding', description: 'onboarding status' },
  { name: 'keybindings', description: 'show loaded keybindings' },
  { name: 'output-style', description: 'list output styles' },
  { name: 'suggest', description: 'ask the model for a suggested next prompt' },
  { name: 'statusline', description: 'run a status line command: /statusline <cmd>' },
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

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// The owner's prompts stand out from the run on a band of their own.
const band = (s: string) => `\x1b[48;5;236m${s}\x1b[49m`;

// What a turn is doing now, above the editor while it runs: the step, the time since the prompt, and while text
// streams its rate. Empty, and so no line at all, between turns.
class ActivityLine implements Component {
  text = '';
  render(width: number): string[] {
    return this.text ? [truncateToWidth(this.text, width)] : [];
  }
  invalidate() {}
}

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
  readonly activity = new ActivityLine();
  theme = loadTheme();
  readonly commandPicker = new CommandPicker(COMMANDS);
  readonly settings: SettingsScreen;
  readonly permissionPicker = new PermissionPicker([{ mode: 'auto', description: 'auto' }, { mode: 'read-only', description: 'read-only' }, { mode: 'plan', description: 'plan' }, { mode: 'workspace', description: 'workspace' }]);
  modelPicker = new ModelPicker([]);
  vimMode: 'vim' | 'default' = 'default';
  vimState: { mode: 'insert' | 'normal'; count?: number; pendingOp?: 'd' | 'c' | 'y' } = { mode: 'insert' };
  loadedKeybindings: ReturnType<typeof loadKeybindings> = [];
  picker: SelectList | null = null;
  // The turn in progress: its step, when it started, and the text streamed so far in the current block.
  private step = '';
  private startedAt = 0;
  private stream: { at: number; chars: number } | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  // The last reply's output rate, from the run's own timing.
  private rate = 0;
  // The first snapshot of the working tree, taken in the background when the TUI opens.
  private warming: Promise<void> | undefined;
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
  readonly controller: CediaController;
  private busyStop: AbortController | undefined;
  private busyPromise: Promise<void> = Promise.resolve();
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
    this.settings = new SettingsScreen({ model: this.model, permission: args.permission, theme: this.theme });
    this.loadedKeybindings = loadKeybindings(cediaHome());
    try {
      const roles = loadRoles({});
      const ml = modelList(roles.code.ref, process.env as Record<string, string | undefined>, undefined);
      this.modelPicker = new ModelPicker(ml.models.map((m) => ({ ref: m.ref, label: m.label, available: m.available, reason: m.reason, effortLevels: m.effortLevels })));
    } catch {}
    this.store = new ThreadStore(threadsDir(cediaHome(), projectKey(args.cwd)));
    this.controller = new CediaController(args, this.run);
    this.controller.onMessage = (m) => this.onMessage(m as CoreMessage);
    this.controller.onState = () => { this.thread = this.controller.thread; this.model = this.controller.model; this.goal = this.controller.goal; this.spent = this.controller.spent; this.context = this.controller.context; if (!this.controller.running) { this.tick(false); } this.refreshStatus(true); };
    this.controller.onActivity = (t) => this.setStep(t);
    this.controller.onDone = (r) => this.done(r);
    this.controller.onError = (e) => this.say(red(`cedia: ${e.message}`));
    this.controller.onNote = (t) => this.onNote(t);
    this.controller.onCommand = (line) => this.viewCommand(line);
    this.controller.onQuit = () => this.quit();
    this.tui = new TUI(terminal);
    this.editor = new Editor(this.tui, { borderColor: dim, selectList: SELECT });
    this.editor.onSubmit = (text) => this.submit(text);
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, args.cwd));
    this.tui.addChild(this.chat);
    this.tui.addChild(this.activity);
    this.tui.addChild(this.editor);
    this.tui.addChild(this.status);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => this.key(data));
  }

  start() {
    try {
      const skills = loadSkills(this.args.cwd, cediaHome());
      for (const sk of skills) if (!COMMANDS.some((c) => c.name === sk.name)) COMMANDS.push({ name: sk.name, description: sk.description });
      this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, this.args.cwd));
    } catch {}
    this.say(dim(`cedia in ${this.args.cwd}. /help for commands; Esc or Ctrl+C stops a turn.`));
    if (!isComplete()) this.say(dim(`onboarding: ${ONBOARDING_STEPS.filter((s) => !loadOnboarding().completed.includes(s)).join(', ')} pending`));
    try { watchKeybindings(cediaHome(), (b) => { this.loadedKeybindings = b; }); } catch {}
    void refreshLocalModelCache().catch(() => {});
    if (process.env.CEDIA_MDM_URL) void fetchMdmSettings().then((d) => { if (Object.keys(d).length) { const { writeFileSync, mkdirSync } = require('node:fs'); const { join } = require('node:path'); mkdirSync(join(cediaHome(), 'mdm-cache'), { recursive: true }); writeFileSync(join(cediaHome(), 'mdm-cache', 'managed-settings.json'), JSON.stringify(d, null, 2)); } }).catch(() => {});
    this.warming = workspaceSnapshots(this.args.cwd, cediaHome())
      ?.warm?.()
      .catch(() => {})
      .finally(() => (this.warming = undefined));
    this.refreshStatus(true);
    this.tui.start();
  }

  stop() {
    this.running?.stop.abort();
    this.tick(false);
    this.tui.stop();
  }

  // Resolves once the turn in progress, if any, has ended.
  async idle(): Promise<void> {
    await this.controller.idle();
    await this.busyPromise;
  }

  // Ctrl+C or Esc stops a turn; with none running, Ctrl+C clears the editor, then leaves, and Ctrl+D leaves.
  private key(data: string): { consume: boolean } | undefined {
    if (this.picker) {
      // Let the focused SelectList handle input directly (arrow keys, Enter, Esc).
      return undefined;
    }
    if ((this.controller.running || this.busyStop) && (matchesKey(data, 'ctrl+c') || matchesKey(data, 'escape'))) {
      this.controller.abort();
      this.busyStop?.abort();
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
    // Apply user keybindings (from ~/.cedia/keybindings.json) when idle.
    if (!this.controller.running && !this.busyStop) {
      const resolved = resolveBindings(this.loadedKeybindings);
      for (const b of resolved) {
        try {
          if (!matchesKey(data, b.key as any)) continue;
        } catch {
          continue;
        }
        const cmd = b.command;
        if (cmd === 'cancel') {
          if (this.editor.getText()) this.editor.setText('');
          else void this.quit();
          return { consume: true };
        }
        // While the editor's autocomplete menu is open (or while typing a slash
        // command, where it is about to open), arrow keys must reach the editor so
        // it can move the selection; do not hijack them for prompt history.
        const ed = this.editor as unknown as { autocompleteState?: unknown; getText?: () => string };
        const inSlashCommand = typeof ed.getText === 'function' && ed.getText().trimStart().startsWith('/');
        if ((cmd === 'historyUp' || cmd === 'historyDown') && (ed.autocompleteState || inSlashCommand)) {
          return undefined;
        }
        if (cmd === 'historyUp') { this.editor.handleInput('\x1b[A'); return { consume: true }; }
        if (cmd === 'historyDown') { this.editor.handleInput('\x1b[B'); return { consume: true }; }
        // submit/autocomplete are handled by the editor itself; consume nothing.
      }
    }
    // Vim mode handling: when on, intercept keys in normal mode and translate to editor actions.
    if (this.vimMode === 'vim') {
      if (this.vimState.mode === 'insert' && (data === '\x1b' || matchesKey(data, 'escape'))) {
        this.vimState = { mode: 'normal' };
        this.say(dim('-- NORMAL --'));
        return { consume: true };
      }
      if (this.vimState.mode === 'normal') {
        if (/^[1-9]$/.test(data) && this.vimState.count === undefined) {
          this.vimState.count = Number(data);
          return { consume: true };
        }
        if (/^[0-9]$/.test(data) && this.vimState.count !== undefined) {
          this.vimState.count = (this.vimState.count ?? 0) * 10 + Number(data);
          return { consume: true };
        }
        const n = this.vimState.count ?? 1;
        if (data === 'i') { this.vimState = { mode: 'insert' }; this.say(dim('-- INSERT --')); return { consume: true }; }
        if (data === 'a') { this.editor.handleInput('\x1b[C'); this.vimState = { mode: 'insert' }; this.say(dim('-- INSERT --')); return { consume: true }; }
        if (data === 'I') { this.editor.handleInput('\x1b[H'); this.vimState = { mode: 'insert' }; this.say(dim('-- INSERT --')); return { consume: true }; }
        if (data === 'A') { this.editor.handleInput('\x1b[F'); this.vimState = { mode: 'insert' }; this.say(dim('-- INSERT --')); return { consume: true }; }
        if (data === 'o') { this.editor.handleInput('\x1b[F'); this.editor.handleInput('\r'); this.vimState = { mode: 'insert' }; this.say(dim('-- INSERT --')); return { consume: true }; }
        if (data === 'O') { this.editor.handleInput('\x1b[H'); this.editor.handleInput('\r'); this.editor.handleInput('\x1b[A'); this.vimState = { mode: 'insert' }; this.say(dim('-- INSERT --')); return { consume: true }; }
        if (data === 'h') { for (let i = 0; i < n; i++) this.editor.handleInput('\x1b[D'); this.vimState = { mode: 'normal', count: undefined }; return { consume: true }; }
        if (data === 'l') { for (let i = 0; i < n; i++) this.editor.handleInput('\x1b[C'); this.vimState = { mode: 'normal', count: undefined }; return { consume: true }; }
        if (data === 'j') { for (let i = 0; i < n; i++) this.editor.handleInput('\x1b[B'); this.vimState = { mode: 'normal', count: undefined }; return { consume: true }; }
        if (data === 'k') { for (let i = 0; i < n; i++) this.editor.handleInput('\x1b[A'); this.vimState = { mode: 'normal', count: undefined }; return { consume: true }; }
        if (data === '0') { this.editor.handleInput('\x1b[H'); this.vimState = { mode: 'normal', count: undefined }; return { consume: true }; }
        if (data === '$') { this.editor.handleInput('\x1b[F'); this.vimState = { mode: 'normal', count: undefined }; return { consume: true }; }
        if (data === 'w') { for (let i = 0; i < n; i++) this.editor.handleInput('\x1bf'); this.vimState = { mode: 'normal', count: undefined }; return { consume: true }; }
        if (data === 'b') { for (let i = 0; i < n; i++) this.editor.handleInput('\x1bb'); this.vimState = { mode: 'normal', count: undefined }; return { consume: true }; }
        if (data === 'x') { for (let i = 0; i < n; i++) this.editor.handleInput('\x1b[3~'); this.vimState = { mode: 'normal', count: undefined }; return { consume: true }; }
        if (data === 'd') {
          if (this.vimState.pendingOp === 'd') {
            const txt = this.editor.getText();
            const cur = this.editor.getCursor();
            const lines = txt.split('\n');
            lines.splice(cur.line, 1);
            this.editor.setText(lines.join('\n'));
            this.vimState = { mode: 'normal' };
            return { consume: true };
          }
          this.vimState.pendingOp = 'd';
          return { consume: true };
        }
        if (data === 'D') {
          const txt = this.editor.getText();
          const cur = this.editor.getCursor();
          const lines = txt.split('\n');
          if (lines[cur.line] !== undefined) {
            lines[cur.line] = lines[cur.line]!.slice(0, cur.col);
            this.editor.setText(lines.join('\n'));
          }
          this.vimState = { mode: 'normal', count: undefined };
          return { consume: true };
        }
        if (data === 'u') { this.vimState = { mode: 'normal', count: undefined }; return { consume: true }; }
        if (data === '\x1b' || matchesKey(data, 'escape')) {
          this.vimState = { mode: 'normal', pendingOp: undefined, count: undefined };
          return { consume: true };
        }
        this.vimState = { mode: 'normal', pendingOp: undefined, count: undefined };
        return { consume: true };
      }
    }
    return undefined;
  }


  private openPicker(title: string, items: SelectItem[], onPick: (v: string) => void) {
    if (this.picker) this.closePicker();
    this.say(dim(title));
    const list = new SelectList(items, Math.min(10, items.length || 1), SELECT);
    list.onSelect = (item) => { onPick(item.value); this.closePicker(); };
    list.onCancel = () => { this.say(dim('cancelled')); this.closePicker(); };
    this.chat.addChild(list);
    this.picker = list;
    try { this.tui.setFocus(list); } catch {}
    this.tui.requestRender();
  }
  private applyModel(ref: string) {
    if (isMode(ref)) {
      this.model = ref;
      this.say(dim(MODES.find((m) => m.name === ref)!.label));
    } else {
      this.model = loadRoles({ code: ref }).code.ref;
      this.say(dim(`the next turn runs on ${this.model}; a thread whose last session used another model goes on in a new session`));
    }
  }
  private closePicker() {
    if (this.picker) { try { this.chat.removeChild(this.picker); } catch {} this.picker = null; try { this.tui.setFocus(this.editor); } catch {} this.tui.requestRender(); }
  }
  // A turn in progress is stopped and given a moment to close its sandbox and finish its logs.
  private async quit() {
    this.controller.abort();
    this.busyStop?.abort();
    await Promise.race([this.idle(), Bun.sleep(5000)]);
    this.stop();
    this.exit();
  }

  say(text: string) {
    this.chat.addChild(new Text(text, 0, 0));
    this.tui.requestRender();
  }

  // The writer's model: the one picked, or the code role when a mode or nothing is.
  private writer(): string {
    return this.model && !isMode(this.model) ? this.model : loadRoles({}).code.ref;
  }

  statusLine(): string {
    return [
      isMode(this.model) ? `${this.model} · ${this.writer()}` : this.writer(),
      this.args.permission ?? 'auto',
      this.git,
      this.thread ?? 'new thread',
      this.goal ? 'goal' : '',
      this.vimMode === 'vim' ? `vim:${this.vimState.mode}` : '',
      this.context ? `ctx ${Math.round(this.context / 1000)}k` : '',
      this.spent ? `$${this.spent.toFixed(4)}` : '',
      this.rate ? `${Math.round(this.rate)} tok/s` : '',
      this.controller.running || this.busyStop ? 'working' : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  // The compact status bar the polish module renders; kept alongside statusLine() for clients.
  statusBar(): string {
    const contextPct = this.context ? Math.min(100, Math.round((this.context / 200000) * 100)) : 0;
    return renderStatusBar({
      model: isMode(this.model) ? `${this.model} · ${this.writer()}` : this.writer(),
      permission: this.args.permission ?? 'auto',
      branch: this.gitStatus?.branch ?? this.git,
      dirtyCount: this.gitStatus?.dirty,
      thread: this.thread ?? 'new thread',
      contextPct,
      spendUsd: this.spent,
      lastRate: this.rate ? Math.round(this.rate) : undefined,
      cols: 100,
    });
  }

  // Git is read in the background, at most one read at a time, with one more queued when asked meanwhile: the
  // core's events arrive inside its own calls, so a slow `git status` must not hold them up.
  private gitReading: 'idle' | 'reading' | 'again' = 'idle';
  private gitStatus: GitStatus | null = null;
  private readGit() {
    if (this.gitReading !== 'idle') {
      this.gitReading = 'again';
      return;
    }
    this.gitReading = 'reading';
    void gitStatusAsync(this.args.cwd).then((g) => {
      this.gitStatus = g ?? null;
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
      let text = this.statusLine();
      try {
        const raw = JSON.parse(readFileSync(join(cediaHome(), 'settings.json'), 'utf8')) as { statusLine?: string };
        if (raw?.statusLine) {
          const out = runStatusLineCommand(raw.statusLine, { model: this.writer(), workspace: this.args.cwd, costUsd: this.spent, contextWindow: this.context, permissionMode: this.args.permission, vimMode: this.vimMode });
          if (out) text = out;
        }
      } catch {}
      this.status.setText(dim(text));
    } catch (e) {
      this.status.setText(red(`status: ${(e as Error).message}`));
    }
    this.tui.requestRender();
  }

  submit(raw: string, planWhen?: 'always' | 'never'): void {
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
    if (text.startsWith('/')) return this.command(text.slice(1));    if (this.controller.running || this.busyStop) {
      this.say(yellow('a turn is running: wait for it, or stop it with Esc'));
      return;
    }
    this.chat.addChild(new Text('', 0, 0));
    this.chat.addChild(new Text(bold(renderUserMessage(text)), 1, 0, band));
    this.chat.addChild(new Text('', 0, 0));
    this.setStep('starting');
    this.tick(true);
    this.controller.submit(text, planWhen);
    // tick(false) and refreshStatus happen via controller onState/onDone callbacks.
  }

  private async turn(prompt: string, signal: AbortSignal, planWhen?: 'always' | 'never') {
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
    if (this.warming) {
      this.setStep('recording the working tree for /undo (first time here)');
      await this.warming;
    }
    try {
      const result = await this.run(
        // The owner may think for minutes between prompts here, so the writer's prefix is cached for an hour.
        { ...args, cacheTtl: args.cacheTtl ?? '1h', streamingTools: true, ...(planWhen ? { planWhen } : {}), ...(this.goal ? { goal: this.goal } : {}), prompt, outputFormat: 'stream-json', ...(this.model ? { model: this.model } : {}), ...(this.thread ? { thread: this.thread } : {}), note: (t) => this.onNote(t), signal },
        out,
      );
      this.done(result);
    } catch (e) {
      this.say(red(`cedia: ${(e as Error).message}`));
    }
  }

  // The step a turn is on, shown with the time since the prompt.
  private setStep(step: string) {
    this.step = step;
    if (step === 'starting') this.startedAt = performance.now();
    this.stream = undefined;
    this.drawActivity();
  }

  private tick(on: boolean) {
    clearInterval(this.ticker);
    this.ticker = on ? setInterval(() => this.drawActivity(), 100) : undefined;
    if (!on) {
      this.activity.text = '';
      this.tui.requestRender();
    }
  }

  private drawActivity() {
    if (!this.ticker && this.step !== 'starting') return;
    const secs = (performance.now() - this.startedAt) / 1000;
    const s = this.stream;
    const streamSecs = s ? (performance.now() - s.at) / 1000 : 0;
    // About four characters a token: a live estimate, replaced by the run's own count when it ends.
    const rate = s && streamSecs > 0.3 ? ` · ~${Math.round(s.chars / 4 / streamSecs)} tok/s` : '';
    this.frame = (this.frame + 1) % SPINNER.length;
    this.activity.text = `${cyan(SPINNER[this.frame]!)} ${this.step} ${dim(`· ${secs.toFixed(secs < 10 ? 1 : 0)}s${rate} · esc to stop`)}`;
    this.tui.requestRender();
  }

  // cedia's own notes: shown, and the ones that name a step move the activity line on.
  private onNote(text: string) {
    const t = text.trimEnd();
    const planning = /^cedia: planning with (.+)$/.exec(t);
    if (planning) return this.setStep(`planning with ${planning[1]}`);
    this.say(yellow(t));
  }

  private onMessage(m: CoreMessage) {
    if (m.type === 'stream') {
      const e = m.event;
      if (e.type === 'text_start') {
        this.live = { md: new Markdown('', 0, 0, MARKDOWN), text: '' };
        this.chat.addChild(this.live.md);
        this.streamed = true;
        this.setStep('writing');
        this.stream = { at: performance.now(), chars: 0 };
      } else if (e.type === 'text_delta' && this.live) {
        this.live.text += e.delta;
        if (this.stream) this.stream.chars += e.delta.length;
        this.live.md.setText(printable(this.live.text));
      } else if (e.type === 'text_end') this.live = undefined;
      else if (e.type === 'thinking_start') this.setStep('thinking');
      this.tui.requestRender();
      return;
    }
    if (m.type === 'event') return this.onEvent(m.event);
  }

  private onEvent(e: SessionEvent) {
    switch (e.kind) {
      case 'request':
        this.streamed = false;
        this.setStep('waiting for the model');
        break;
      case 'assistant': {
        // A reply that did not stream (a scripted model, a retry) is drawn whole.
        if (!this.streamed) for (const b of e.blocks) if (b.type === 'text' && b.text.trim()) this.chat.addChild(new Markdown(printable(b.text), 0, 0, MARKDOWN));
        const u = e.usage;
        this.context = u.uncached + u.cacheRead + u.cacheWrite + u.output;
        break;
      }
      case 'tool_intent': {
        const line = callLine(e.tool, e.input);
        const args = line.slice(e.tool.length).trim();
        this.say(renderToolCard({ icon: '●', name: e.tool, args, status: 'running' }));
        this.setStep(`running ${e.tool}`);
        break;
      }
      case 'permission':
        if (e.decision === 'deny') this.say(red(`✗ ${e.tool} denied by ${e.rule}${e.reason ? `: ${e.reason}` : ''}`));
        break;
      case 'tool_result': {
        const lines = printable(e.output.text).split('\n');
        const first = lines.find((l) => l.trim()) ?? '';
        const more = lines.length > 1 ? dim(` (+${lines.length - 1} lines)`) : '';
        const exit = e.output.exitCode !== undefined ? dim(` exit=${e.output.exitCode}`) : '';
        const spill = e.output.spillPath ? dim(` (full output: ${e.output.spillPath})`) : '';
        const head = `  ⎿ ${e.status === 'completed' ? '' : `${e.status}: `}${first.length > 160 ? `${first.slice(0, 157)}...` : first}`;
        this.say((e.output.isError ? red(head) : dim(head)) + more + exit + spill);
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
    if (r.timing?.outputTokPerSec) this.rate = r.timing.outputTokPerSec;
    const wall = (performance.now() - this.startedAt) / 1000;
    const parts = [
      r.subtype === 'success' ? 'done' : r.subtype,
      `${r.numTurns} turn${r.numTurns === 1 ? '' : 's'}`,
      `$${r.costUsd.toFixed(4)}`,
      `${wall.toFixed(1)}s`,
      ...(r.timing?.outputTokPerSec ? [`${Math.round(r.timing.outputTokPerSec)} tok/s`] : []),
      ...(r.timing?.ttftMs && r.numTurns ? [`first token ${(r.timing.ttftMs / r.numTurns / 1000).toFixed(1)}s`] : []),
      `cache ${Math.round(r.cacheHitRatio * 100)}%`,
    ];
    this.say(dim(parts.join(' · ')));
    this.say(dim(renderReceipt({ verified: r.subtype === 'success', verdict: r.subtype, turns: r.numTurns, timeMs: Math.round(wall * 1000), costUsd: r.costUsd, checks: [], changed: [] })));
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

  command(line: string): void {
    this.controller.command(line);
  }

  viewCommand(line: string): void {
    const [name = '', ...rest] = line.trim().split(/\s+/);
    try {
      switch (name) {
        case 'help':
          this.say(renderOverlay({ title: 'commands', body: COMMANDS.map((c) => `/${c.name}  ${c.description}`).join('\n'), footer: 'Enter sends; Esc/Ctrl+C stops; Ctrl+D leaves' }));
          return;
        case 'quit':
        case 'exit':
          return void this.quit();
      }
      // The rest read or change what a turn works on, so they wait for it.
      if ((this.controller.running || this.busyStop) && COMMANDS.some((c) => c.name === name)) return this.say(yellow(`a turn is running: stop it (Esc) before /${name}`));
      // A skill invoked as a slash command: ask the writer to load it first (headless skillCommand).
      const skills = loadSkills(this.args.cwd, cediaHome());
      const skill = skills.find((sk) => sk.name === name);
      if (skill) {
        const arg = rest.join(' ').trim();
        return this.submit(arg ? `/${name} ${arg}` : `/${name}`);
      }
      switch (name) {
        case 'config': {
          const pp = join(cediaHome(), 'settings.json');
          let raw = '{}';
          try { raw = readFileSync(pp, 'utf8'); } catch {}
          this.say(`settings file: ${pp}\\n${raw.trim() || '{}'}`);
          break;
        }
        case 'cost':
          this.say(`spent $${this.spent.toFixed(4)} · context ${this.context} tokens · rate ${Math.round(this.rate)} tok/s`);
          break;
        case 'context':
          this.say(`context: ${this.context} tokens${this.context ? ` (~${Math.round(this.context / 1000)}k)` : ''}`);
          break;
        case 'status':
          this.say(this.statusLine());
          break;
        case 'transcript': {
          const rendered = this.chat.render(100).join('\n');
          this.say(renderOverlay({ title: 'transcript', body: rendered.slice(0, 4000), footer: 'Esc to close' }));
          break;
        }
        case 'search': {
          const term = rest.join(' ').trim();
          if (!term) { this.say(dim('/search <term>')); break; }
          const lines = this.chat.render(100).filter((l) => l.toLowerCase().includes(term.toLowerCase()));
          this.say(lines.length ? lines.join('\n') : dim('no matches'));
          break;
        }
        case 'actions': {
          const items: SelectItem[] = [
            { value: 'copy', label: 'copy last reply' },
            { value: 'rewind', label: 'rewind to a run' },
            { value: 'fork', label: 'fork this thread' },
            { value: 'clear', label: 'clear view' },
          ];
          this.openPicker('message actions', items, (v) => { this.viewCommand(`/${v}`); });
          break;
        }
        case 'clear':
          this.chat.clear();
          this.tui.requestRender();
          this.say(dim('cleared'));
          break;
        case 'rename': {
          const title = rest.join(' ').trim();
          if (!title) { this.say(dim('/rename <title>')); break; }
          if (!this.thread) { this.say(dim('no thread yet')); break; }
          try { const named = this.store.rename(this.thread, title); this.say(green(`renamed: ${named}`)); }
          catch (e) { this.say(red((e as Error).message)); }
          break;
        }
        case 'resume': {
          if (!rest[0]) this.say(this.store.list().filter((t) => !t.archived).map(threadLine).join('\\n') || dim('no threads in this project'));
          else if (!this.store.has(rest[0])) this.say(red(`no thread ${rest[0]} in this project`));
          else {
            this.thread = rest[0];
            this.context = 0;
            this.say(dim(`going on with ${threadLine(this.store.read(rest[0]))}${this.goal ? '; the goal still holds (/goal off ends it)' : ''}`));
          }
          break;
        }
        case 'color': {
          // alias for theme: reuse by delegating
          this.viewCommand(rest.length ? `/theme ${rest.join(' ')}` : '/theme');
          break;
        }
        case 'hooks': {
          const pp = join(cediaHome(), 'settings.json');
          let raw: Record<string, unknown> = {};
          try { raw = JSON.parse(readFileSync(pp, 'utf8')) as Record<string, unknown>; } catch {}
          const hooks = (raw.hooks ?? {}) as Record<string, unknown[]>;
          const lines = ['hooks'];
          for (const e of ['preToolUse', 'postToolUse', 'stop']) lines.push(`  ${e}: ${(hooks[e] ?? []).length}`);
          lines.push(`file: ${pp}`);
          this.say(lines.join('\\n'));
          break;
        }
        case 'effort': {
          const lvl = rest[0];
          const pp = join(cediaHome(), 'settings.json');
          if (!lvl) {
            let raw: Record<string, unknown> = {};
            try { raw = JSON.parse(readFileSync(pp, 'utf8')) as Record<string, unknown>; } catch {}
            this.say(dim(`effort: ${String(raw.effort ?? '(default)')}`));
            break;
          }
          try {
            let raw: Record<string, unknown> = {};
            try { raw = JSON.parse(readFileSync(pp, 'utf8')) as Record<string, unknown>; } catch {}
            raw.effort = lvl;
            writeFileSync(pp, JSON.stringify(raw, null, 2) + '\\n');
            this.say(green(`effort: ${lvl}`));
          } catch (e) { this.say(red((e as Error).message)); }
          break;
        }
        case 'branch': {
          try {
            const r = Bun.spawnSync(['git', 'branch', '-a'], { cwd: this.args.cwd });
            const out = r.stdout.toString().trim();
            this.say(out || dim('not a git repository or no branches'));
          } catch (e) { this.say(red((e as Error).message)); }
          break;
        }
        case 'copy': {
          const last = [...this.chat.children].reverse().find((c) => c instanceof Text) as Text | undefined;
          const text = (last as unknown as { text?: string })?.text ?? '';
          if (!text) { this.say(dim('nothing to copy')); break; }
          try {
            const proc = Bun.spawn(['pbcopy'], { stdin: new TextEncoder().encode(text) });
            void proc.exited;
            this.say(green('copied the last reply'));
          } catch (e) { this.say(red((e as Error).message)); }
          break;
        }
        case 'tasks':
          // fall through to agents
        case 'agents': {
          if (!this.thread) { this.say(dim('no thread yet')); break; }
          const children = this.store.list().filter((t) => t.parent === this.thread);
          this.say(children.length ? children.map((t) => `${t.id}  ${t.title}`).join('\\n') : dim('no sub-threads / tasks'));
          break;
        }
        case 'compact':
          this.say(dim('compaction/handoff runs automatically when the context grows long (--handoff-at, --handoff). Use /thread to inspect sessions.'));
          break;
        case 'fast': {
          const pp = join(cediaHome(), 'settings.json');
          let raw: Record<string, unknown> = {};
          try { raw = JSON.parse(readFileSync(pp, 'utf8')) as Record<string, unknown>; } catch {}
          const cur = raw.fast === true;
          raw.fast = !cur;
          try { writeFileSync(pp, JSON.stringify(raw, null, 2) + '\\n'); this.say(green(`fast mode: ${raw.fast ? 'on' : 'off'}`)); }
          catch (e) { this.say(red((e as Error).message)); }
          break;
        }
        case 'export': {
          if (!this.thread) { this.say(dim('no thread yet')); break; }
          const t = this.store.read(this.thread);
          const path = rest[0] || join(this.args.cwd, `${this.thread}.txt`);
          try {
            const lines = [`thread: ${t.id}`, `title: ${t.title}`, `task: ${t.task}`, '', ...t.messages.map((m) => `${m.from}: ${m.text}`)];
            writeFileSync(path, lines.join('\\n') + '\\n');
            this.say(green(`exported to ${path}`));
          } catch (e) { this.say(red((e as Error).message)); }
          break;
        }
        case 'agents': {
          if (!this.thread) { this.say(dim('no thread yet')); break; }
          const children = this.store.list().filter((t) => (t as { parent?: string }).parent === this.thread);
          this.say(children.length ? children.map((t) => `${t.id}  ${t.title}`).join('\\n') : dim('no sub-threads'));
          break;
        }
        case 'btw': {
          const q = rest.join(' ').trim();
          if (!q) { this.say(dim('/btw <question>')); break; }
          return this.submit(`By the way, a side question (do not derail the main task): ${q}`);
        }
        case 'diff':
          return this.diff();
        case 'undo':
        case 'redo':
          return this.restore(name, rest[0] === 'force');
        case 'rewind': {
          if (!this.thread) return this.say(dim('no thread yet: nothing to rewind'));
          const runs = runLines(this.store.read(this.thread));
          if (!rest[0]) {
            if (!runs.length) { this.say(dim('no runs to rewind to')); return; }
            const items: SelectItem[] = runs.map((r, i) => ({ value: String(i + 1), label: r }));
            this.openPicker('rewind to run', items, (v) => { this.viewCommand(`/rewind ${v}`); });
            return;
          }
          const n = Number(rest[0]);
          if (!Number.isInteger(n)) return this.say(dim('/rewind <n>'));
          const r = rewindThread(this.store, this.thread, n, { open: (cwd) => workspaceSnapshots(cwd, cediaHome()), sessionFile: (cwd, sid) => sessionPath(cwd, sid) }, { force: rest[1] === 'force' });
          if ('error' in r) return this.say(red(r.error));
          this.context = 0;
          this.say(rewoundText(r));
          return;
        }
        case 'fork': {
          if (!this.thread) return this.say(dim('no thread yet: nothing to fork'));
          const at = rest[0] ?? 'end';
          const side = rest.includes('--side');
          const r = forkThread(this.store, this.thread, at, { sessionFile: (cwd, sid) => sessionPath(cwd, sid) }, { side });
          if ('error' in r) return this.say(red(r.error));
          this.thread = r.thread;
          this.context = 0;
          this.say(dim(`forked into ${r.thread}${r.run ? ` (at run ${r.run})` : ''}${side ? ' (side chat)' : ''}`));
          return;
        }
        case 'memory': {
          const store = new MemoryStore(memoryPath(cediaHome(), projectKey(this.args.cwd)));
          const text = line.trim().slice('memory'.length).trim();
          if (!text) {
            const notes = store.notes();
            this.say(notes.length ? notes.map((n) => `${n.id}  ${n.text}`).join('\n') : dim('no memory notes for this project'));
            return;
          }
          try {
            const n = store.add(text, 'tui');
            this.say(green(`remembered ${n.id}: ${n.text}`));
          } catch (e) {
            this.say(red((e as Error).message));
          }
          return;
        }
        case 'skills': {
          const skills = loadSkills(this.args.cwd, cediaHome());
          this.say(skills.length ? skills.map((s) => `${s.name}  ${dim(s.description)}`).join('\n') : dim('no skills for this project'));
          return;
        }
        case 'mcp': {
          const { servers } = listMcp();
          this.say(servers.length ? servers.map((s) => `${s.name}  ${dim(s.command ?? s.url ?? '')}`).join('\n') : dim('no MCP servers configured'));
          return;
        }
        case 'commit':
          // The message as typed, new lines included.
          return void this.busy((signal) => this.commit(line.trim().slice(name.length), signal));
        case 'pr':
          return this.pr();
        case 'review':
          return void this.busy((signal) => this.review(rest[0], signal));
        case 'plan':
        case 'quick': {
          const prompt = line.trim().slice(name.length).trim();
          if (!prompt) return this.say(dim(`/${name} <prompt>`));
          return this.submit(prompt, name === 'plan' ? 'always' : 'never');
        }
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
            this.say(dim(`going on with ${threadLine(this.store.read(rest[0]))}${this.goal ? '; the goal still holds (/goal off ends it)' : ''}`));
          }
          break;
        case 'models':
        case 'model': {
          if (!rest[0]) {
            this.say(dim(`the next turn runs on ${this.model ?? loadRoles({}).code.ref}; opening model picker…`));
            const roles = loadRoles({});
            const ml = modelList(roles.code.ref, process.env as Record<string, string | undefined>, undefined);
            const items: SelectItem[] = [
              ...ml.models.map((m) => ({ value: m.ref, label: `${m.available ? ' ' : '-'} ${m.ref}  ${m.label}${m.available ? '' : ` (${m.reason})`}` })),
              { value: 'auto', label: 'auto  code role from settings, triage decides per message' },
              { value: 'oplan', label: 'oplan  roles from settings, every message planned' },
            ];
            this.openPicker('models', items, (v) => this.applyModel(v));
            break;
          }
          const arg = rest[0];
          const roles = loadRoles({});
          const ml = modelList(roles.code.ref, process.env as Record<string, string | undefined>, undefined);
          const models = ml.models.map((m) => ({ ref: m.ref, label: m.label, available: m.available, reason: m.reason, effortLevels: m.effortLevels }));
          let ref = arg;
          if (/^\d+$/.test(arg)) {
            const idx = Number(arg) - 1;
            if (idx < 0 || idx >= models.length) { this.say(red(`no model #${arg} (1..${models.length})`)); break; }
            ref = models[idx]!.ref;
            if (!models[idx]!.available) { this.say(red(`${ref} is unavailable: ${models[idx]!.reason}`)); break; }
          }
          if (isMode(ref)) {
            this.model = ref;
            this.say(dim(MODES.find((m) => m.name === ref)!.label));
          } else {
            this.model = loadRoles({ code: ref }).code.ref;
            this.say(dim(`the next turn runs on ${this.model}; a thread whose last session used another model goes on in a new session`));
          }
          break;
        }
        case 'settings': {
          // A real settings page: show every configurable item with its current
          // value and a short description, then open a picker so the owner can
          // select one instead of having to remember the individual commands.
          const roles = loadRoles({});
          const currentModel = this.model ?? roles.code.ref;
          const lines = [
            'settings',
            `  model         ${currentModel}   the writer model (or auto/oplan mode)`,
            `  permission    ${this.args.permission ?? 'auto'}   read-only | plan | workspace | auto`,
            `  theme         ${this.theme}   dark or light`,
            `  output style  ${loadOutputStyleSetting(cediaHome())}   named output style from ~/.cedia`,
            `  vim mode      ${this.vimMode}   vim keybindings on/off`,
            'pick one below to change it (Esc cancels); or run /model, /permission, /theme, /output-style, /vim directly.',
          ];
          this.say(lines.join('\\n'));
          const items: SelectItem[] = [
            { value: 'model', label: `model         ${currentModel}` },
            { value: 'permission', label: `permission    ${this.args.permission ?? 'auto'}` },
            { value: 'theme', label: `theme         ${this.theme}` },
            { value: 'output-style', label: `output style  ${loadOutputStyleSetting(cediaHome())}` },
            { value: 'vim', label: `vim mode      ${this.vimMode}` },
          ];
          this.openPicker('settings', items, (v) => { this.viewCommand(`/${v}`); });
          break;
        }
        case 'theme': {
          const arg = rest[0];
          if (!arg) {
            this.say(dim(`theme: ${this.theme}; opening picker…`));
            const items: SelectItem[] = [{ value: 'dark', label: 'dark' }, { value: 'light', label: 'light' }];
            this.openPicker('theme', items, (v) => { this.theme = v as 'dark' | 'light'; this.settings.set('theme', this.theme); this.say(green(`theme: ${this.theme}`)); });
            break;
          }
          const t = arg === '1' ? 'dark' : arg === '2' ? 'light' : arg;
          if (t !== 'dark' && t !== 'light') { this.say(red(`unknown theme: ${arg}`)); break; }
          this.theme = t as 'dark' | 'light';
          this.settings.set('theme', this.theme);
          this.say(green(`theme: ${this.theme}`));
          break;
        }
        case 'doctor': {
          const info = versionInfo();
          const home = cediaHome();
          const bunWhich = Bun.which('bwrap') || Bun.which('sandbox-exec');
          this.say([
            `cedia doctor`,
            `version: ${info.version}`,
            `home: ${home}`,
            `cwd: ${this.args.cwd}`,
            `sandbox: ${bunWhich ? 'available' : 'unavailable'} (${bunWhich ?? 'no tool'})`,
            `keybindings: ${this.loadedKeybindings.length} loaded`,
            `mcp servers: ${listMcp().servers.length}`,
            `vim mode: ${this.vimMode}`,
            `onboarding complete: ${isComplete()}`,
          ].join('\n'));
          break;
        }
        case 'permission': {
          const arg = rest[0];
          if (!arg) {
            const cur = this.args.permission ?? 'auto';
            this.say(dim(`permission: ${cur}; opening picker…`));
            const items: SelectItem[] = this.permissionPicker.modes.map((m) => ({ value: m.mode, label: `${m.mode}  ${m.description}` }));
            this.openPicker('permissions', items, (v) => { this.args.permission = v; this.settings.set('permission', v); this.say(green(`permission mode: ${v}`)); });
            break;
          }
          let mode = arg;
          if (/^\d+$/.test(arg)) {
            const idx = Number(arg) - 1;
            if (idx < 0 || idx >= this.permissionPicker.modes.length) { this.say(red(`no mode #${arg}`)); break; }
            mode = this.permissionPicker.modes[idx]!.mode;
          }
          if (!this.permissionPicker.pick(mode)) { this.say(red(`unknown mode: ${mode}`)); break; }
          this.args.permission = mode;
          this.settings.set('permission', mode);
          this.say(green(`permission mode: ${mode}`));
          break;
        }
        case 'vim': {
          this.vimMode = toggleVim(this.vimMode);
          this.vimState = toInsert(this.vimState as any);
          this.say(dim(`vim mode: ${this.vimMode}`));
          break;
        }
        case 'onboarding': {
          if (rest[0] === 'start') {
            markStep('preflight');
            this.say(dim('onboarding started: theme -> apiKey -> trust -> terminal. Use /onboarding <step> to mark, /onboarding accept for trust.'));
            break;
          }
          if (rest[0] === 'next') {
            const ss = loadOnboarding();
            const pp = ONBOARDING_STEPS.filter((st) => !ss.completed.includes(st));
            if (pp.length) markStep(pp[0]!);
            break;
          }
          if (rest[0] && rest[0] !== 'accept') markStep(rest[0]);
          const s = loadOnboarding();
          const pending = ONBOARDING_STEPS.filter((st) => !s.completed.includes(st));
          this.say([`completed: ${s.completed.join(', ') || '(none)'}`, `trust: ${s.hasTrustDialogAccepted ? 'accepted' : 'pending'}`, `pending: ${pending.join(', ') || '(none)'}`, `complete: ${isComplete()}`].join('\n'));
          if (rest[0] === 'accept') { acceptTrust(); this.say(green('trust accepted')); }
          break;
        }
        case 'keybindings': {
          const resolved = resolveBindings(this.loadedKeybindings);
          this.say(resolved.length ? resolved.map((b) => `${b.key}  ${dim(b.context ?? '*')}  ${b.command}`).join('\n') : dim('no keybindings'));
          break;
        }
        case 'output-style': {
          const styles = loadOutputStyles(cediaHome());
          const current = loadOutputStyleSetting(cediaHome());
          if (!rest[0]) {
            this.say(dim(`output style: ${current}; opening picker…`));
            const items: SelectItem[] = styles.map((s) => ({ value: s.name, label: `${s.name === current ? '*' : ' '} ${s.name}  ${s.description ?? ''}` }));
            this.openPicker('output styles', items, (v) => {
              try {
                const pp = join(cediaHome(), 'settings.json');
                let raw: Record<string, unknown> = {};
                try { raw = JSON.parse(readFileSync(pp, 'utf8')); } catch {}
                raw.outputStyle = v;
                writeFileSync(pp, JSON.stringify(raw, null, 2) + '\n');
                this.say(green(`output style: ${v}`));
              } catch (e) { this.say(red((e as Error).message)); }
            });
            break;
          }
          const picked = styles.find((s) => s.name === rest[0]);
          if (!picked) { this.say(red(`unknown style: ${rest[0]}`)); break; }
          try {
            const pp = join(cediaHome(), 'settings.json');
            let raw: Record<string, unknown> = {};
            try { raw = JSON.parse(readFileSync(pp, 'utf8')); } catch {}
            raw.outputStyle = picked.name;
            writeFileSync(pp, JSON.stringify(raw, null, 2) + '\n');
            this.say(green(`output style: ${picked.name}`));
          } catch (e) { this.say(red((e as Error).message)); }
          break;
        }
        case 'statusline': {
          const cmd = line.trim().slice('statusline'.length).trim();
          if (!cmd) { this.say(dim('usage: /statusline <command>')); break; }
          const out = runStatusLineCommand(cmd, { model: this.writer(), workspace: this.args.cwd, costUsd: this.spent, contextWindow: this.context, permissionMode: this.args.permission, vimMode: this.vimMode });
          this.say(out || dim('(no output)'));
          break;
        }
        case 'suggest': {
          if (!this.thread) { this.say(dim('no thread yet')); break; }
          this.say(dim('asking for a suggestion…'));
          void this.busy(async (signal) => {
            this.controller.submit('Suggest one short, concrete next user prompt for this thread (one line, no quotes).');
            await this.controller.idle();
          });
          break;
        }
        case 'palette': {
          const items: SelectItem[] = COMMANDS.map((c) => ({ value: c.name, label: `/${c.name}  ${c.description}` }));
          this.openPicker('commands', items, (v) => { this.viewCommand(`/${v}`); });
          break;
        }
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
    this.busyStop = stop;
    let resolveBusy: () => void = () => {};
    this.busyPromise = new Promise<void>((r) => { resolveBusy = r; });
    this.refreshStatus();
    try {
      await work(stop.signal);
    } catch (e) {
      this.say(red((e as Error).message));
    } finally {
      this.busyStop = undefined;
      this.refreshStatus(true);
      resolveBusy();
    }
  }

  private async commit(own: string, signal: AbortSignal) {
    if (!this.thread) return this.say(dim('no thread yet: nothing to commit'));
    const snaps = workspaceSnapshots(this.args.cwd, cediaHome());
    if (!snaps) return this.say(red('no snapshots for this directory, so cedia cannot tell which files the thread changed'));
    const files = threadChanges(this.store, this.thread, this.args.cwd, snaps);
    if (!files.length) return this.say(dim('nothing this thread changed differs from HEAD'));
    let message = own.trim();
    if (!message) {
      // The next turn's model writes it.
      const drafted = await draftCommitMessage({ cwd: this.args.cwd, model: this.writer(), files, ...(this.args.privacy ? { privacy: this.args.privacy } : {}), signal });
      this.spent += drafted.costUsd;
      message = drafted.message;
    }
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

  // /review: the review role's model (the next turn's model when none is set) reads the change in a session of its
  // own, read-only, logged like any other. Findings on the working tree can go back to the thread's writer.
  private async review(pr: string | undefined, signal: AbortSignal) {
    let subject: ReviewSubject;
    let patch: string;
    if (pr) {
      const got = await pullRequest(this.args.cwd, pr.replace(/^#/, ''), undefined, signal);
      if ('error' in got) return this.say(red(got.error));
      subject = { kind: 'pr', number: pr.replace(/^#/, ''), title: got.title, body: got.body };
      patch = got.patch;
    } else {
      const w = workingDiff(this.args.cwd);
      if (!w) return this.say(dim('not a git repository'));
      if (!w.patch && !w.untracked.length) return this.say(dim('no changes to review'));
      subject = { kind: 'changes', untracked: w.untracked };
      patch = w.patch;
    }
    const roles = loadRoles(this.model && !isMode(this.model) ? { code: this.model } : {});
    const model = roles.review?.via === 'cedia' ? roles.review.model : resolveModel(this.writer());
    this.say(dim(`reviewing ${subject.kind === 'pr' ? `pull request #${subject.number}` : 'the uncommitted changes'} with ${model.ref}…`));
    const fauxScript = process.env.CEDIA_FAUX_SCRIPT ? JSON.parse(readFileSync(process.env.CEDIA_FAUX_SCRIPT, 'utf8')) : undefined;
    const id = crypto.randomUUID();
    const log = SessionLog.create({ id, path: sessionPath(this.args.cwd, id) });
    // Its calls and replies are drawn as a turn's are; its context is not the thread's, so the status line keeps that.
    log.listeners.push((e) => {
      if (e.kind === 'assistant') for (const b of e.blocks) if (b.type === 'text' && b.text.trim()) this.chat.addChild(new Markdown(printable(b.text), 0, 0, MARKDOWN));
      if (e.kind === 'tool_intent' || e.kind === 'tool_result' || e.kind === 'permission') this.onEvent(e);
      this.tui.requestRender();
    });
    const r = await runPrompt(
      {
        log,
        provider: providerFor(model, { fauxScript }),
        model,
        tools: CORE_TOOLS.filter((t) => t.effect !== 'write_workspace'),
        system: systemFor(model),
        cwd: this.args.cwd,
        role: 'review',
        // The user's policy, its guards and deny rules included, made read-only: a PR's text may ask for a secret.
        permission: { ...loadPolicy(this.args.cwd, { allow: this.args.allow ?? [], deny: this.args.deny ?? [], unlock: this.args.unlock ?? [] }), mode: 'read-only' },
        privacy: loadPrivacy(this.args.cwd, this.args.privacy),
        maxTurns: 40,
        signal,
      },
      askedReviewPrompt(subject, patch),
    );
    this.spent += r.costUsd;
    this.say(dim(`review ${r.subtype === 'success' ? 'done' : r.subtype} · ${r.numTurns} turn${r.numTurns === 1 ? '' : 's'} · $${r.costUsd.toFixed(4)}`));
    if (r.subtype !== 'success') return void (r.result.trim() && this.say(red(printable(r.result.trim()))));
    const { verdict, findings } = parseVerdict(r.result);
    // Findings on a pull request stay with the user: its branch may not be this working tree's.
    if (verdict !== 'changes' || subject.kind !== 'changes' || !findings) return;
    this.say(yellow(`send these findings to ${this.thread ? "this thread's writer" : 'a new thread'} to fix? y to send; n, or anything else you type, cancels`));
    this.pending = { what: 'sending the findings', yes: (s) => { this.controller.submit(fixPrompt(model.ref, findings)); return this.controller.idle(); } };
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
