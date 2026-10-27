import { describe, expect, test } from 'bun:test';
import { renderStatusBar } from '../src/clients/tui/status-bar.ts';
import { renderOverlay, renderPermissionPrompt } from '../src/clients/tui/overlays.ts';
import { bashDialog, editDialog, webFetchDialog, askUserDialog } from '../src/clients/tui/permission-dialogs.ts';

describe('tui phase f', () => {
  test('status bar compact', () => {
    const s = renderStatusBar({ model: 'm', permission: 'auto', contextPct: 80, spendUsd: 1, cols: 60 });
    expect(s).toContain('ctx 80%');
    expect(s).not.toContain('$1.00');
  });
  test('warning colors', () => {
    const s = renderStatusBar({ model: 'm', permission: 'auto', contextPct: 95, spendUsd: 1, cols: 100 });
    expect(s).toContain('RED');
  });
  test('overlay', () => { expect(renderOverlay({ title: 't', body: 'b' })).toContain('t'); });
  test('permission prompt', () => { expect(renderPermissionPrompt('bash', 'ls')).toContain('Permission: bash'); });
  test('bash dialog', () => { expect(bashDialog('ls', 1000)).toContain('timeout 1000ms'); });
  test('edit dialog', () => { expect(editDialog('f', 'a', 'b')).toContain('+ b'); });
  test('webfetch dialog', () => { expect(webFetchDialog('http://x')).toContain('WebFetch'); });
  test('askuser dialog', () => { expect(askUserDialog('q?', ['a', 'b'])).toContain('1. a'); });
});
