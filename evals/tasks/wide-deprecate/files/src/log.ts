export type Level = 'debug' | 'info' | 'warn' | 'error';

let sink: (line: string) => void = (line) => console.log(line);

// Tests and the CLI route lines elsewhere.
export function setSink(s: (line: string) => void): void {
  sink = s;
}

const write = (level: Level, msg: string) => sink(`${level.toUpperCase()} ${msg}`);

export const log = {
  debug: (msg: string) => write('debug', msg),
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
  // For a level only known at run time.
  at: (level: Level, msg: string) => write(level, msg),
};

/** @deprecated Use log.<level>(msg), or log.at(level, msg) when the level is a variable. */
export function oldLog(level: Level, msg: string): void {
  write(level, msg);
}
