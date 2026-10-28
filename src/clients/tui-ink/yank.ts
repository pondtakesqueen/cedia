// In-process vim yank register for the ink prompt (no OS clipboard required).

let register = '';

export function yankText(text: string): void {
  register = text;
}

export function yankedText(): string {
  return register;
}

/** Test helper: clear the register between cases. */
export function clearYank(): void {
  register = '';
}
