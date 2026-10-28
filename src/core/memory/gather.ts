import { readFileSync } from 'node:fs';
import { cediaHome } from '../config.ts';
import { projectKey } from '../session/log.ts';
import { SessionLog } from '../session/log.ts';
import { resolveModel } from '../providers/catalog.ts';
import { providerFor } from '../providers/index.ts';
import { runPrompt } from '../loop/run.ts';
import { loadPrivacy } from '../config.ts';
import { memoryPath, MemoryStore, rememberTool, MAX_NOTE } from '../project/memory.ts';
import { consolidateLockPath, readLock, writeLock } from '../project/consolidate.ts';

export async function gatherNotes(opts: { cwd: string; home?: string; model?: string; thread?: string; force?: boolean; now?: Date }) {
  const home = opts.home ?? cediaHome();
  const slug = projectKey(opts.cwd);
  const lockPath = consolidateLockPath(home, slug);
  const store = new MemoryStore(memoryPath(home, slug));
  const now = opts.now ?? new Date();
  const before = store.notes().length;

  // Lock: prevent concurrent extraction.
  const existing = readLock(lockPath);
  if (!opts.force && existing) {
    const age = now.getTime() - Date.parse(existing.lastConsolidatedAt);
    if (age >= 0 && age < 60_000) {
      return { extracted: false, skipped: 'concurrent', notesBefore: before, notesAfter: before, added: 0, lockPath };
    }
  }

  // Gather transcript from last session if thread provided, else scan all.
  const { scanTranscripts } = await import('../project/consolidate.ts');
  const scan = scanTranscripts(home, slug);
  if (!scan.text.trim()) {
    writeLock(lockPath, now);
    return { extracted: true, notesBefore: before, notesAfter: before, added: 0, lockPath, sessionsScanned: scan.count };
  }

  const modelRef = opts.model ?? (process.env.CEDIA_FAUX_SCRIPT ? 'faux' : 'beam');
  const model = resolveModel(modelRef);
  const fauxScript = process.env.CEDIA_FAUX_SCRIPT ? JSON.parse(readFileSync(process.env.CEDIA_FAUX_SCRIPT, 'utf8')) : undefined;
  const provider = providerFor(model, { fauxScript });
  const id = crypto.randomUUID();
  const log = SessionLog.create({ id, path: null });
  const privacy = loadPrivacy(opts.cwd, undefined);
  const system = `You extract durable memories from a session transcript. Keep short facts (commands that work, decisions and reasons, where things live, traps). Not progress. At most ${MAX_NOTE} chars per note. Use remember tool, at most 5 notes. If nothing durable, call nothing.`;
  const prompt = `Extract durable memories from these transcripts:\n\n${scan.text}`;
  await runPrompt(
    {
      log,
      provider,
      model,
      tools: [rememberTool(store, 'extract')],
      system,
      cwd: opts.cwd,
      role: 'extract',
      permission: { mode: 'workspace', allow: [], deny: [] },
      privacy,
      maxTurns: 6,
    },
    prompt,
  );
  writeLock(lockPath, now);
  const after = store.notes().length;
  return { extracted: true, notesBefore: before, notesAfter: after, added: after - before, lockPath, sessionsScanned: scan.count };
}
