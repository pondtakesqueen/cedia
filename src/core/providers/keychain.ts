// API keys in the macOS Keychain, read after the environment, so the CLI and the desktop share one store and
// neither passes keys to the other. A key is a generic password with service "cedia" and the environment
// variable's name as its account:
//
//   security add-generic-password -s cedia -a ANTHROPIC_API_KEY -w
//
// Bash calls that read the Keychain are denied by the secret-path guard (core/safety/policy.ts), so a model
// cannot read a key back out.

export const KEYCHAIN_SERVICE = 'cedia';

// Account (an env variable name) -> the key, or undefined when there is none.
export type Keychain = (account: string) => string | undefined;

// `security` exits 44 when the item is not there. Anything else that fails (a locked keychain the user did not
// unlock, a missing binary) is a missing key too: the run goes on and says the key is not set.
export function securityKeychain(bin = '/usr/bin/security', service = KEYCHAIN_SERVICE): Keychain {
  const cache = new Map<string, string | undefined>();
  return (account) => {
    if (cache.has(account)) return cache.get(account);
    let key: string | undefined;
    try {
      const p = Bun.spawnSync([bin, 'find-generic-password', '-s', service, '-a', account, '-w'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
      key = p.exitCode === 0 ? p.stdout.toString().trim() || undefined : undefined;
    } catch {
      key = undefined;
    }
    cache.set(account, key);
    return key;
  };
}

// The Keychain on macOS, unless CEDIA_KEYCHAIN=off. CEDIA_SECURITY_BIN points tests (on any platform) at a fake
// `security`.
export function systemKeychain(env: Record<string, string | undefined> = process.env, platform = process.platform): Keychain | undefined {
  if (env.CEDIA_KEYCHAIN === 'off') return undefined;
  if (env.CEDIA_SECURITY_BIN) return securityKeychain(env.CEDIA_SECURITY_BIN);
  return platform === 'darwin' ? securityKeychain() : undefined;
}

let system: Keychain | undefined | null = null;
// One reader per process, so each key costs one `security` call at most.
export const processKeychain = (): Keychain | undefined => (system === null ? (system = systemKeychain()) : system);
