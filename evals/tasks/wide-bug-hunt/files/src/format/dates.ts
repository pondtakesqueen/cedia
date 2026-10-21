// ISO date (YYYY-MM-DD) in UTC.
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}
