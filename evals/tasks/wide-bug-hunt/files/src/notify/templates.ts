// {{name}} placeholders; unknown names are left as they are.
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m);
}
