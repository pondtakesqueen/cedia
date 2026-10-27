import { runHeadless } from '../headless/main.ts';
import type { HeadlessArgs } from '../headless/main.ts';
import type { HeadlessResult, SessionEvent } from '../../core/types.ts';
import { decode } from '../../protocol/index.ts';
import type { CoreMessage } from '../../protocol/index.ts';
import { workspaceSnapshots } from '../../core/safety/snapshot.ts';
import { cediaHome } from '../../core/config.ts';

export type TuiArgs = Omit<HeadlessArgs, 'prompt' | 'outputFormat' | 'note' | 'signal'>;

export type UIMessage = { role: 'user' | 'assistant' | 'tool' | 'system'; text: string; status?: 'running' | 'success' | 'error' };

export type RunFn = (args: HeadlessArgs, out: (chunk: string) => void) => Promise<HeadlessResult>;

export class CediaController {
  readonly args: TuiArgs;
  private run: RunFn;

  thread: string | undefined;
  model: string | undefined;
  permission: string | undefined;
  goal: string | undefined;
  running: boolean = false;
  messages: UIMessage[] = [];
  spent: number = 0;
  context: number = 0;
  vimMode: 'vim' | 'default' = 'default';
  activity: string = '';

  private warming: Promise<void> | undefined;
  private startedAt: number = 0;
  private stopController: AbortController | undefined;

  onMessage?: (m: CoreMessage) => void;
  onState?: () => void;
  onActivity?: (text: string) => void;
  onDone?: (r: HeadlessResult) => void;
  onError?: (e: Error) => void;
  onNote?: (text: string) => void;

  constructor(args: TuiArgs, run?: RunFn) {
    this.args = args;
    this.run = run ?? runHeadless;
    this.thread = args.thread;
    this.model = args.model;
    this.permission = args.permission;
    this.goal = args.goal;
  }

  start(): void {
    const w = workspaceSnapshots(this.args.cwd, cediaHome());
    this.warming = w?.warm?.()?.catch(() => {})?.finally(() => { this.warming = undefined; });
  }

  stop(): void {
    this.stopController?.abort();
  }

  idle(): Promise<void> { return Promise.resolve(); }

  abort(): void {
    this.stopController?.abort();
    this.running = false;
    this.onState?.();
  }

  applyModel(ref: string): void { this.model = ref; this.onState?.(); }
  quit(): void {}

  submit(text: string, planWhen?: 'always' | 'never'): void {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith('/')) {
      this.command(t.slice(1));
      return;
    }
    if (this.running) {
      this.onActivity?.('a turn is running: wait for it, or stop it with Esc');
      return;
    }
    this.messages.push({ role: 'user', text: t });
    this.onMessage?.({ type: 'user', text: t } as unknown as CoreMessage);
    this.startedAt = performance.now();
    this.activity = 'starting';
    this.onActivity?.(this.activity);
    const stop = new AbortController();
    this.stopController = stop;
    this.running = true;
    this.onState?.();

    const runTurn = async () => {
      if (this.warming) {
        this.activity = 'recording the working tree';
        this.onActivity?.(this.activity);
        await this.warming;
        this.warming = undefined;
      }
      let buffer = '';
      const out = (chunk: string) => {
        buffer += chunk;
        for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const m = decode<CoreMessage>(line);
            this.onMessage?.(m);
          } catch {
            // ignore unparseable lines
          }
        }
      };
      const { goal: _, ...args } = this.args;
      try {
        const result = await this.run(
          { ...args, cacheTtl: args.cacheTtl ?? '1h', streamingTools: true, ...(planWhen ? { planWhen } : {}), ...(this.goal ? { goal: this.goal } : {}), prompt: t, outputFormat: 'stream-json', ...(this.model ? { model: this.model } : {}), ...(this.thread ? { thread: this.thread } : {}), note: (txt: string) => this.onNote?.(txt), signal: stop.signal },
          out,
        );
        this.thread = result.thread ?? this.thread;
        this.spent += result.costUsd;
        const u = (result as { usage?: { uncached?: number; cacheRead?: number; cacheWrite?: number; output?: number } }).usage;
        if (u) this.context = (u.uncached ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
        this.onDone?.(result);
      } catch (e) {
        this.onError?.(e as Error);
      } finally {
        this.running = false;
        this.stopController = undefined;
        this.onState?.();
      }
    };
    void runTurn();
  }

  command(line: string): void {
    const trimmed = line.trim();
    const name = trimmed.split(/\s+/)[0] ?? '';
    if (name === 'new') { this.thread = undefined; this.messages = []; this.onState?.(); return; }
    if (name === 'goal') {
      const cond = trimmed.slice('goal'.length).trim();
      if (cond === 'off') { this.goal = undefined; } else if (cond) { this.goal = cond; }
      this.onState?.();
      return;
    }
    if (name === 'thread') {
      const id = trimmed.slice('thread'.length).trim();
      if (id) { this.thread = id; this.messages = []; this.onState?.(); }
      return;
    }
    if (name === 'model') {
      const ref = trimmed.slice('model'.length).trim();
      if (ref) this.applyModel(ref);
      return;
    }
    if (name === 'quit' || name === 'exit') { this.quit(); return; }
    // Other commands are view-specific; fire a callback for the view to handle.
    this.onCommand?.(line);
  }

  onCommand?: (line: string) => void;
}
