export type Overlay = { title: string; body: string; footer?: string };

export function renderOverlay(o: Overlay): string {
  if (process.env.CEDIA_SCREEN_READER === '1' || process.env.CEDIA_AX_SCREEN_READER === '1') {
    return [o.title, o.body, o.footer].filter(Boolean).join('\n');
  }
  const border = '╭' + '─'.repeat(Math.max(10, o.title.length + 4)) + '╮';
  const bottom = '╰' + '─'.repeat(Math.max(10, o.title.length + 4)) + '╯';
  return `${border}\n│ ${o.title} │\n│ ${o.body} │\n${o.footer ? '│ ' + o.footer + ' │\n' : ''}${bottom}`;
}

export function renderPermissionPrompt(tool: string, preview: string): string {
  return renderOverlay({ title: `Permission: ${tool}`, body: preview, footer: 'Allow / Deny / Ask' });
}
