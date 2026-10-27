import { describe, expect, test } from 'bun:test';
import { loadTheme, palette } from '../src/clients/tui/theme.ts';
import { renderToolCard, renderThinking, renderReceipt, renderSessionDivider } from '../src/clients/tui/message-list.ts';
import { filterCommands, CommandPicker } from '../src/clients/tui/command-picker.ts';
import { groupByProvider } from '../src/clients/tui/model-picker.ts';
import { PermissionPicker } from '../src/clients/tui/permission-picker.ts';
import { SettingsScreen } from '../src/clients/tui/settings-screen.ts';

describe('tui polish', () => {
  test('theme', () => { expect(loadTheme()).toBe('dark'); expect(palette.dark.accent).toBeTruthy(); });
  test('tool card', () => { const s = renderToolCard({ icon: '', name: 'bash', args: 'ls', status: 'success', exitCode: 0, durationMs: 10 }); expect(s).toContain('bash'); });
  test('thinking', () => { expect(renderThinking('t', true)).toContain('กำลังคิด'); });
  test('receipt', () => { expect(renderReceipt({ verified: true, turns: 2, timeMs: 10, costUsd: 0.1, checks: ['bun test'], changed: ['a.ts'] })).toContain('verified'); });
  test('divider', () => { expect(renderSessionDivider().length).toBeGreaterThan(0); });
  test('command picker filter', () => {
    const cmds = [{ name: 'help', description: 'h' }, { name: 'hello', description: 'x' }];
    const f = filterCommands(cmds, 'hel');
    expect(f[0]!.name).toBe('help');
    const p = new CommandPicker(cmds);
    p.setQuery('hel');
    expect(p.selected()!.name).toBe('help');
  });
  test('model group', () => { const g = groupByProvider([{ ref: 'a/b', label: 'l', available: true }]); expect(g.a).toHaveLength(1); });
  test('permission chip', () => { const p = new PermissionPicker([{ mode: 'auto', description: 'd' }]); expect(p.chip('auto', 2)).toBe('auto +2'); });
  test('settings screen', () => { const s = new SettingsScreen({ a: 1 }); s.set('a', 2); expect(s.get('a')).toBe(2); expect(s.render()).toContain('a'); });
});
