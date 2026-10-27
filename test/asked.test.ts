import { describe, expect, test } from 'bun:test';
import { askedBannerText } from '../src/clients/tui-ink/asked.ts';

describe('asked banner', () => {
  test('open question without options', () => {
    expect(askedBannerText({ question: 'proceed?' })).toBe('? proceed?\nanswer with your next prompt');
  });
  test('options numbered in order', () => {
    expect(askedBannerText({ question: 'pick', options: ['a', 'b'] })).toBe('? pick\n  1. a\n  2. b\nanswer with your next prompt');
  });
});
