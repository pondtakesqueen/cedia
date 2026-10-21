// Lines written before 1.4 had no level prefix; the parser below accepts both.
export function parseLine(line: string): { level: string; msg: string } {
  const m = /^(DEBUG|INFO|WARN|ERROR) (.*)$/.exec(line);
  return m ? { level: m[1]!.toLowerCase(), msg: m[2]! } : { level: 'info', msg: line };
}
