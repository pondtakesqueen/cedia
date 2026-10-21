// Units to order so stock reaches `target`, in packs of `pack`.
export function restockUnits(current: number, target: number, pack: number): number {
  if (current >= target) return 0;
  return Math.ceil((target - current) / pack) * pack;
}
