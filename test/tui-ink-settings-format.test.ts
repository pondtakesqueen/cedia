import { describe, expect, test } from 'bun:test';
import { humanizeSettingKey, settingDisplayValue } from '../src/clients/tui-ink/settings-format.ts';

describe('settings-format', () => {
  test('humanizeSettingKey humanizes keys like cc labels', () => {
    expect(humanizeSettingKey('cacheTtl')).toBe('Cache TTL');
    expect(humanizeSettingKey('outputStyle')).toBe('Output Style');
    expect(humanizeSettingKey('permission')).toBe('Permission');
    expect(humanizeSettingKey('max_turns')).toBe('Max Turns');
    expect(humanizeSettingKey('apiKey')).toBe('Api Key'.replace('Api', 'API'));
  });

  test('settingDisplayValue marks objects with a submenu indicator', () => {
    expect(settingDisplayValue(true)).toEqual({ text: 'true', submenu: false });
    expect(settingDisplayValue('a')).toEqual({ text: '"a"', submenu: false });
    expect(settingDisplayValue({ a: 1, b: 2 })).toEqual({ text: '2 keys ›', submenu: true });
    expect(settingDisplayValue([1, 2, 3])).toEqual({ text: '3 items ›', submenu: true });
  });
});
