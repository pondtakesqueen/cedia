export type Context = 'Global' | 'Chat' | 'Autocomplete' | 'Settings' | 'Confirmation' | 'Tabs' | 'Transcript' | 'HistorySearch' | 'Task' | 'ThemePicker' | 'Scroll' | 'Help' | 'Attachments' | 'Footer' | 'MessageSelector' | 'MessageActions' | 'DiffDialog' | 'ModelPicker' | 'Select' | 'Plugin';

export type Binding = { key: string; command: string; context?: Context };

export type KeybindingsFile = { bindings?: Binding[] };

export const CHORD_TIMEOUT_MS = 1000;
