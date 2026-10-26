import type { HeadlessArgs } from '../headless/main.ts';
import type { HeadlessResult, SessionEvent } from '../../core/types.ts';

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

  onMessage?: (m: UIMessage) => void;
  onState?: () => void;
  onActivity?: (text: string) => void;
  onDone?: (r: HeadlessResult) => void;

  constructor(args: TuiArgs, run?: RunFn) {
    this.args = args;
    this.run = run ?? (async () => { throw new Error('run not provided'); });
    this.thread = args.thread;
    this.model = args.model;
    this.permission = args.permission;
    this.goal = args.goal;
  }

  start(): void {}
  stop(): void {}
  idle(): Promise<void> { return Promise.resolve(); }
  submit(text: string, planWhen?: 'always' | 'never'): void {}
  command(line: string): void {}
  abort(): void {
    this.running = false;
  }
  applyModel(ref: string): void { this.model = ref; }
  quit(): void {}
}