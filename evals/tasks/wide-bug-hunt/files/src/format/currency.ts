import type { Cents } from '../money/cents.ts';

// 123456 -> "1,234.56". Negative amounts keep their sign in front.
export function money(c: Cents): string {
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`;
}
