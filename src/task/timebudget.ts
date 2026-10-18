export function timeBudgetLine(startedAt: number, budgetMs: number): string {
  const elapsed = Date.now() - startedAt;
  const elapsedSec = Math.round(elapsed / 1000);
  const budgetSec = Math.round(budgetMs / 1000);
  return `elapsed ${elapsedSec}s / ${budgetSec}s`;
}