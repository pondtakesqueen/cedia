// test/tui-ink-boot.test.ts
// Manual smoke checklist (requires a TTY):
//   CEDIA_HOME=/tmp/inkhome bun src/cli.ts --tui ink
//   - type a prompt; reply streams
//   - status bar renders thread/model/permission/running
//   - Esc aborts a running turn (activity shows 'stopping…')
import { describe, expect, test } from 'bun:test';

describe('ink app module', () => {
  test('imports app module (ESM interop)', async () => {
    const mod = await import('../src/clients/tui-ink/app.tsx');
    expect(mod).toBeTruthy();
    expect(typeof mod.App).toBe('function');
  });
});