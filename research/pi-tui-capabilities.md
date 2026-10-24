# pi-tui capabilities (Phase A probe)

Package: `@mariozechner/pi-tui` (node_modules).

- Input handling: `EditorComponent.handleInput(data: string)` receives raw terminal input; supports custom editors (vim/emacs) via the interface.
- Keybindings: `KeybindingsManager` with definitions, user overrides (`KeybindingsConfig`), conflict detection, `matches(data, keybinding)`, hot-reload via `setUserBindings`. Chord sequences not built-in as multi-key chords? KeyId-based; chord interceptor must be custom (timeout 1000ms).
- Status line: TUI is component-based (`Component` render); status bar can be a custom component. No built-in status line command runner, but render hook available.
- Overlays/modals: component tree; overlays possible via conditional rendering.
- Mouse: terminal abstraction exists; mouse support depends on terminal.

Decision: stay on pi-tui. Implement custom keybinding resolver/chord interceptor, vim editor component implementing EditorComponent, status line component executing settings.statusLine, and doctor as a command (not TUI screen) initially.

No Ink migration needed.
