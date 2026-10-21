export type Account = { id: string; email: string; region: string; createdAt: string };

const ACCOUNTS: Account[] = [];

export function signUp(email: string, region: string, now = new Date()): Account {
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error(`bad email ${email}`);
  if (ACCOUNTS.some((a) => a.email === email)) throw new Error(`${email} already has an account`);
  const a = { id: `u${ACCOUNTS.length + 1}`, email, region, createdAt: now.toISOString() };
  ACCOUNTS.push(a);
  return a;
}
