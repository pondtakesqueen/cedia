import { themeFromOsc11, type ThemeName } from './theme-tokens.ts';

// Asks the terminal for its background color before the TUI takes the screen (OSC 11, as OpenCode and Neovim
// do), so a person who never chose a theme gets the one that suits it. Every terminal answers the DA1 query
// sent after it, so a DA1 answer with no color before it means the terminal does not say; a terminal that
// answers neither is given up on after `timeoutMs`.
export const OSC11_QUERY = '\x1b]11;?\x1b\\';
export const DA1_QUERY = '\x1b[c';
const DA1_REPLY = /\x1b\[\?[\d;]*c/;

type Input = NodeJS.ReadStream & { setRawMode?: (on: boolean) => unknown };

export async function queryTerminalTheme(stdin: Input, stdout: NodeJS.WriteStream, timeoutMs = 500): Promise<ThemeName | undefined> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') return undefined;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  let got = '';
  try {
    return await new Promise<ThemeName | undefined>((resolve) => {
      const done = (theme: ThemeName | undefined) => {
        clearTimeout(timer);
        stdin.off('readable', onReadable);
        resolve(theme);
      };
      // Read as Ink does ('readable', not 'data'), so the stream never starts flowing and Ink finds it as it was.
      const onReadable = () => {
        let chunk: Buffer | string | null;
        while ((chunk = stdin.read()) !== null) got += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
        const theme = themeFromOsc11(got);
        if (theme || DA1_REPLY.test(got)) done(theme);
      };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      stdin.on('readable', onReadable);
      stdout.write(OSC11_QUERY + DA1_QUERY);
    });
  } finally {
    stdin.setRawMode(wasRaw);
  }
}
