// When the shell stops the process (Ctrl+Z) and later continues it (fg / SIGCONT),
// the alternate-screen frame is often stale. Listeners bump React state so Ink
// redraws after the host has cleared its recorded frame height.

const listeners = new Set<() => void>();

export function onTerminalResume(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyTerminalResume(): void {
  for (const listener of listeners) listener();
}

/** Attach SIGCONT → clear + notify. Returns a disposer. */
export function attachSigcontRedraw(clear: () => void): () => void {
  const onCont = () => {
    clear();
    notifyTerminalResume();
  };
  process.on('SIGCONT', onCont);
  return () => {
    process.off('SIGCONT', onCont);
  };
}
