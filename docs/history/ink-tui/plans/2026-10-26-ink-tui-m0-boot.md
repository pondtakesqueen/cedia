# Ink TUI M0 — Boot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cedia --tui ink` start at a TTY, render a prompt, stream a reply, show a status bar, and abort cleanly on Esc/Ctrl+C. No crash. Fix the ESM interop blocker.

**Architecture:** Keep the existing `runHeadless` + stream-json path. The ink app (`src/clients/tui-ink/app.tsx`) is the view. Replace `ink-markdown` (CJS/incompatible) with a local markdown renderer using `marked` + `marked-terminal` via dynamic `import()`. Add a status bar component and wire abort. No controller extraction yet (that is M0.5).

**Tech Stack:** Bun, React, ink 8.x, ink-text-input, marked, marked-terminal (nested under ink-markdown's node_modules), pi-tui not used.

**Spec:** `docs/history/ink-tui/specs/2026-10-26-ink-tui-design.md` (M0 section).

## Global Constraints

- Typecheck clean: `bun run typecheck`.
- All existing tests green: `bun test`.
- No new runtime dependency; reuse `marked` + `marked-terminal` already installed under `node_modules/ink-markdown/node_modules`.
- Do not modify `src/clients/tui/main.ts` in this plan (pi-tui stays untouched).
- `src/clients/tui-ink/*` is the only code touched besides a new markdown module and a new smoke test.

---

### Task 1: Markdown renderer module (replacing ink-markdown)

**Files:**
- Create: `src/clients/tui-ink/markdown.tsx`
- Test: `test/tui-ink-markdown.test.ts`

**Interfaces:**
- Produces: default export `Markdown` React component accepting `{ children: string }` and optional `{ ...options }`, rendering parsed markdown as ANSI inside `<Text>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/tui-ink-markdown.test.ts
import { describe, expect, test } from 'bun:test';

describe('ink markdown renderer', () => {
  test('module imports and exports a default component', async () => {
    const mod = await import('../src/clients/tui-ink/markdown.tsx');
    expect(typeof mod.default).toBe('function');
  });

  test('renderMarkdown returns a non-empty string for markdown input', async () => {
    const { renderMarkdown } = await import('../src/clients/tui-ink/markdown.tsx');
    const out = await renderMarkdown('# Hello\n\n- item one\n- item two\n');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('Hello');
    expect(out).toContain('item one');
  });

  test('renderMarkdown does not throw on empty input', async () => {
    const { renderMarkdown } = await import('../src/clients/tui-ink/markdown.tsx');
    const out = await renderMarkdown('');
    expect(typeof out).toBe('string');
  });

  test('renderMarkdown does not throw on code blocks', async () => {
    const { renderMarkdown } = await import('../src/clients/tui-ink/markdown.tsx');
    const out = await renderMarkdown('```ts\nconst x = 1;\n```\n');
    expect(out).toContain('const x = 1;');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/tui-ink-markdown.test.ts`
Expected: FAIL (module not found / export missing).

- [ ] **Step 3: Write minimal implementation**

Create `src/clients/tui-ink/markdown.tsx`:

```tsx
import React from 'react';
import { Text } from 'ink';

// Use dynamic imports: `marked` and `marked-terminal` are ESM/CJS interop
// that break under Bun when required synchronously (ink-markdown hits this).
export async function renderMarkdown(src: string): Promise<string> {
  try {
    const { marked } = await import('marked');
    const markedTerminalMod = await import('marked-terminal');
    const markedTerminal = (markedTerminalMod as { default?: unknown }).default ?? markedTerminalMod;
    marked.setOptions({ renderer: new (markedTerminal as new (opts?: unknown) => unknown)() });
    const parsed = marked.parse(src ?? '');
    return String(parsed ?? '').trim();
  } catch {
    return src ?? '';
  }
}

export default function Markdown({ children }: { children: string }): React.ReactElement {
  const [text, setText] = React.useState<string>(children ?? '');
  React.useEffect(() => {
    let cancelled = false;
    void renderMarkdown(children ?? '').then((t) => {
      if (!cancelled) setText(t);
    });
    return () => { cancelled = true; };
  }, [children]);
  return React.createElement(Text, null, text);
}
```

Note: `marked-terminal` resolves via `node_modules/ink-markdown/node_modules`; if the direct import fails, add a tsconfig path or import from the nested location. Verify with the test.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/tui-ink-markdown.test.ts`
Expected: PASS (4 tests).

If the dynamic import of `marked-terminal` fails to resolve, adjust the import to
`'ink-markdown/node_modules/marked-terminal'` or add a path mapping in `tsconfig.json`
paths (and document it).

- [ ] **Step 5: Commit**

```bash
git add src/clients/tui-ink/markdown.tsx test/tui-ink-markdown.test.ts
git commit -m "feat(tui-ink): add markdown renderer (replacing ink-markdown)"
```

---

### Task 2: Status bar component

**Files:**
- Create: `src/clients/tui-ink/status-bar.tsx`
- Test: `test/tui-ink-status.test.ts`

**Interfaces:**
- Produces: `StatusBar` component accepting `{ thread?, model?, permission?, running, context?, spend? }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/tui-ink-status.test.ts
import { describe, expect, test } from 'bun:test';

describe('ink status bar', () => {
  test('module imports', async () => {
    const mod = await import('../src/clients/tui-ink/status-bar.tsx');
    expect(mod).toBeTruthy();
    expect(typeof mod.StatusBar).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/tui-ink-status.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Create `src/clients/tui-ink/status-bar.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';

export function StatusBar(props: {
  thread?: string;
  model?: string;
  permission?: string;
  running: boolean;
  context?: number;
  spend?: number;
}): React.ReactElement {
  const { thread, model, permission, running, context, spend } = props;
  return React.createElement(
    Box,
    { flexDirection: 'row', justifyContent: 'space-between', paddingX: 1 },
    React.createElement(Text, { dimColor: true }, thread ?? 'new thread'),
    React.createElement(Text, { color: running ? 'cyan' : 'gray' }, running ? 'working' : 'idle'),
    React.createElement(Text, { dimColor: true }, model ?? 'auto'),
    React.createElement(Text, { dimColor: true }, permission ?? 'auto'),
    context ? React.createElement(Text, { dimColor: true }, `ctx ${Math.round(context / 1000)}k`) : null,
    typeof spend === 'number' ? React.createElement(Text, { dimColor: true }, `$${spend.toFixed(4)}`) : null,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/tui-ink-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/clients/tui-ink/status-bar.tsx test/tui-ink-status.test.ts
git commit -m "feat(tui-ink): add status bar component"
```

---

### Task 3: Wire markdown + status bar into app; fix ESM interop

**Files:**
- Modify: `src/clients/tui-ink/app.tsx`
- Test: `test/tui-ink-boot.test.ts` (manual checklist fallback if no TTY)

**Interfaces:**
- Consumes: `Markdown` (Task 1), `StatusBar` (Task 2).

- [ ] **Step 1: Replace ink-markdown import with local Markdown**

In `src/clients/tui-ink/app.tsx`, remove:
```tsx
import Markdown from 'ink-markdown';
```
Add:
```tsx
import Markdown from './markdown.tsx';
import { StatusBar } from './status-bar.tsx';
```
Replace `<Markdown>{m.text}</Markdown>` usage with `<Markdown>{m.text}</Markdown>` (same API, now local). Add `<StatusBar ... />` in the layout (replace the existing dim status `<Text>` line or augment it).

- [ ] **Step 2: Add abort handling verification**

Ensure the existing `useInput` handles Esc to abort the running turn. The current code sets vim mode on Esc; for abort, call the stop controller. Verify `submit` stores `stop` (AbortController) accessible. Add a ref:
```tsx
const stopRef = React.useRef<AbortController | null>(null);
```
In `submit`, set `stopRef.current = stop;`. In `useInput`, on Esc when running, call `stopRef.current?.abort()` and set activity 'stopping…'.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Smoke test (manual)**

Run at a real terminal:
```bash
CEDIA_HOME=/tmp/inkhome bun src/cli.ts --tui ink
```
Type a prompt; verify reply streams, status bar shows, Esc aborts. Document result in the test file as a checklist comment if no automated TTY test.

- [ ] **Step 5: Commit**

```bash
git add src/clients/tui-ink/app.tsx
git commit -m "feat(tui-ink): wire local markdown + status bar, fix ESM interop"
```

---

### Task 4: Boot smoke test (automated where possible)

**Files:**
- Create: `test/tui-ink-boot.test.ts`

**Interfaces:**
- Produces: a test that imports the ink app module without crashing (mirrors `test/tui-wire.test.ts`).

- [ ] **Step 1: Write the test**

```ts
// test/tui-ink-boot.test.ts
import { describe, expect, test } from 'bun:test';

describe('ink tui boot (smoke)', () => {
  test('app module imports without crashing', async () => {
    const mod = await import('../src/clients/tui-ink/app.tsx');
    expect(mod).toBeTruthy();
    expect(typeof mod.App).toBe('function');
  });

  test('index module imports without crashing', async () => {
    const mod = await import('../src/clients/tui-ink/index.ts');
    expect(mod).toBeTruthy();
    expect(typeof mod.runInkTui).toBe('function');
  });

  test('markdown + status modules import', async () => {
    const md = await import('../src/clients/tui-ink/markdown.tsx');
    const sb = await import('../src/clients/tui-ink/status-bar.tsx');
    expect(typeof md.default).toBe('function');
    expect(typeof sb.StatusBar).toBe('function');
  });
});
```

- [ ] **Step 2: Run test**

Run: `bun test test/tui-ink-boot.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/tui-ink-boot.test.ts
git commit -m "test(tui-ink): add boot smoke tests"
```

---

## Self-Review (run before execution)

1. **Spec coverage:** M0 (boot, abort, status bar, markdown) covered by Tasks 1–4. M0.5 (controller extraction) is NOT in this plan — it is the next plan. This plan deliberately ships a runnable ink TUI first.
2. **Placeholder scan:** All steps have concrete code. The manual smoke step (Task 3 Step 4) is a checklist, not a code step.
3. **Type consistency:** `Markdown` default export and `StatusBar` named export match the imports in Task 3.

## Execution Handoff

Plan complete and saved to `docs/history/ink-tui/plans/2026-10-26-ink-tui-m0-boot.md`.

Two execution options:

1. Subagent-Driven (recommended) - fresh subagent per task + two-stage review.
2. Inline Execution - execute tasks in this session.

Which approach?