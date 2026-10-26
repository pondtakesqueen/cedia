import { runHeadless } from '../headless/main.ts';
import type { TuiArgs } from './main.ts';
import type { CoreMessage } from '../../protocol/index.ts';

export class CediaController {
  readonly args: TuiArgs;
  private run: typeof runHeadless;

  thread: string | undefined;
  model: string | undefined;
  permission: string | undefined;
  goal: string | undefined;
  running: boolean = false;
  messages: CoreMessage[] = [];
  spent: number = 0;
  context: number = 0;
  vimMode: 'vim' | 'default' = 'default';

  onMessage?: (m: CoreMessage) => void;
  onState?: () => void;
  onActivity?: (text: string) => void;

  constructor(args: TuiArgs, run: typeof runHeadless = runHeadless) {
    this.args = args;
    this.run = run;
    this.thread = args.thread;
    this.model = args.model;
    this.permission = args.permission;
    this.goal = args.goal;
  }

  start(): void {}
  stop(): void {}
  idle(): void {}
  submit(text: string, planWhen?: 'always' | 'never'): void {}
  command(line: string): void {}
  abort(): void {
    this.running = false;
  }
}
