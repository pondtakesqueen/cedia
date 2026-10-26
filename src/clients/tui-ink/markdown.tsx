import React from 'react';
import { Text } from 'ink';

// Use dynamic imports: `marked` and `marked-terminal` are ESM/CJS interop
// that break under Bun when required synchronously (ink-markdown hits this).
// `marked`/`marked-terminal` resolve through ink-markdown's nested deps, which
// are the versions ink-markdown itself uses (marked v9 + marked-terminal v6);
// the top-level `marked` (v15) is ABI-incompatible with marked-terminal v6.
export async function renderMarkdown(src: string): Promise<string> {
  try {
    const { marked } = (await import('ink-markdown/node_modules/marked')) as { marked: any };
    const markedTerminalSpecifier = 'ink-markdown/node_modules/marked-terminal';
    const markedTerminalMod: any = await import(markedTerminalSpecifier);
    const markedTerminal: any =
      markedTerminalMod?.default?.default ??
      markedTerminalMod?.default ??
      markedTerminalMod;
    marked.setOptions({ renderer: new markedTerminal() } as any);
    const parsed = marked.parse(src ?? '');
    return String(parsed ?? '').trim();
  } catch {
    return src ?? '';
  }
}

export default function Markdown({ children, ...options }: { children: string } & Record<string, unknown>): React.ReactElement {
  const [text, setText] = React.useState<string>(children ?? '');
  React.useEffect(() => {
    let cancelled = false;
    void renderMarkdown(children ?? '').then((t) => {
      if (!cancelled) setText(t);
    });
    return () => { cancelled = true; };
  }, [children]);
  return React.createElement(Text, options as Record<string, unknown>, text);
}
