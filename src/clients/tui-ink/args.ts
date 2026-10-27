import type { HeadlessArgs } from '../headless/main.ts';

// The arguments a terminal UI runs with: everything headless takes except the prompt itself (typed, not given),
// the output shape (a live screen, not JSON), and the run controls the TUI owns (note, signal).
export type TuiArgs = Omit<HeadlessArgs, 'prompt' | 'outputFormat' | 'note' | 'signal'>;
