import { describe, expect, test } from 'bun:test';
import '../src/clients/tui/theme.ts';
import '../src/clients/tui/message-list.ts';
import '../src/clients/tui/command-picker.ts';
import '../src/clients/tui/model-picker.ts';
import '../src/clients/tui/permission-picker.ts';
import '../src/clients/tui/settings-screen.ts';
import '../src/clients/tui/status-bar.ts';
import '../src/clients/tui/overlays.ts';
import '../src/clients/tui/permission-dialogs.ts';

describe('tui wire smoke', () => {
  test('modules import', () => { expect(true).toBe(true); });
});
