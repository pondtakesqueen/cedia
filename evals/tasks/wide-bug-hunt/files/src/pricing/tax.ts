import type { Cents } from '../money/cents.ts';
import { percentOf } from '../money/round.ts';
import type { Region } from './regions.ts';

// TODO: some regions round tax per line; check whether any of ours do before changing this.
export function taxFor(r: Region, taxable: Cents): Cents {
  return percentOf(taxable, r.taxRate);
}
