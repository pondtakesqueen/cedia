const RULES: [RegExp, string][] = [
  [/\bgit\s+push\b[^;&|]*\s(-f|--force|--force-with-lease)(=[^\s'"]*)?(\s|$|['"])/, "force-push rewrites history on the remote"],
  [/\bgit\s+push\b[^;&|]*\s\+\S/, "force-push via a +refspec rewrites history on the remote"],
  [/\bgit\s+reset\s+[^;&|]*--hard\b/, "git reset --hard discards uncommitted work"],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, "git clean deletes untracked files"],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, "discards every uncommitted change in the tree"],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\bgh\s+release\s+create\b|\bdocker\s+push\b/, "publishes a package, release or image"],
  [/\bvercel\b[^;&|]*--prod\b|\bfly(ctl)?\s+deploy\b|\brailway\s+up\b|\bkubectl\s+(apply|delete)\b|\bterraform\s+(apply|destroy)\b|\bhelm\s+(install|upgrade|uninstall)\b/, "deploys or changes live infrastructure"],
  [/\bgh\s+(pr|issue)\s+(create|comment|merge|close|review|edit|ready)\b/, "acts on GitHub under your name"],
  [/hooks\.slack\.com|discord(app)?\.com\/api\/webhooks/, "sends a message to other people"],
];

const BROAD_PATH = /^(\/|~|\$HOME|\$\{HOME\}|\.|\.\.|\*|\.\/\*)$|^(\/|~|\$HOME)\/[^/\s]*\/?$/;
const PARENT_TRAVERSAL = /(^|[/\s])\.\.(?=[/\s]|$)/;

export function gateReason(command: string): string | undefined {
  const lower = command.toLowerCase();
  for (const [pattern, reason] of RULES) if (pattern.test(command) || pattern.test(lower)) return reason;
  return broadRecursiveDelete(command) ?? broadRecursiveDelete(lower);
}

function broadRecursiveDelete(command: string): string | undefined {
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const words = segment.trim().split(/\s+/).map((w) => w.replace(/^["']+|["']+$/g, ""));
    const rm = words.findIndex((w) => w === "rm" || w.endsWith("/rm"));
    if (rm === -1) continue;
    const args = words.slice(rm + 1);
    const flags = args.filter((a) => a.startsWith("-")).join("");
    const recursive = /-[a-zA-Z]*r|--recursive/i.test(flags);
    const force = /-[a-zA-Z]*f|--force/.test(flags);
    const targets = args.filter((a) => !a.startsWith("-"));
    if (recursive && force && targets.some((t) => BROAD_PATH.test(t) || PARENT_TRAVERSAL.test(t))) return "recursive delete of a broad path";
  }
  return undefined;
}

const ALLOWLIST: RegExp[] = [
  /^\s*(git\s+(status|diff|log|branch)(\s|$)|npm\s+(test|run\s+lint|run\s+typecheck)(\s|$)|npx\s+(tsc\s+--noEmit|vitest(\s+run)?)(\s|$)|node\s+test\.js(\s|$)|python3?\s+-m\s+pytest(\s|$)|ls(\s|$)|pwd(\s|$)|echo(\s|$))/,
];

export function isAlwaysAllowed(command: string): boolean {
  return ALLOWLIST.some((re) => re.test(command.trim()));
}
