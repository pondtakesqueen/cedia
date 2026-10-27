import { describe, expect, test } from 'bun:test';
import '../src/clients/tui-ink/index.ts';
import '../src/clients/tui-ink/app.tsx';
import '../src/clients/tui-ink/markdown.tsx';
import '../src/clients/tui-ink/vim-input.tsx';

describe('tui-ink boot smoke', () => {
  test('modules import', () => { expect(true).toBe(true); });
});
