/** Webview 内共享的轻量 UI 辅助（toast / prompt） */

export function toast(text: string, isError = false): void {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

export function promptValue(text: string, initial = ''): string | null {
  const value = window.prompt(text, initial);
  return value === null ? null : value.trim();
}

/** 在指定位置弹出上下文菜单，返回所选 index 或 null */
export function showMenuAt(
  host: HTMLElement,
  x: number,
  y: number,
  items: Array<{ label: string; danger?: boolean }>,
  onPick: (index: number) => void,
): void {
  host.innerHTML = items
    .map((it, i) => `<div class="ctx-item${it.danger ? ' danger' : ''}" data-i="${i}">${escapeHtml(it.label)}</div>`)
    .join('');
  host.hidden = false;
  host.style.left = `${x}px`;
  host.style.top = `${y}px`;
  host.querySelectorAll<HTMLElement>('.ctx-item').forEach((el) => {
    el.addEventListener('click', () => {
      host.hidden = true;
      onPick(Number(el.dataset.i));
    });
  });
  setTimeout(() => {
    document.addEventListener('click', () => (host.hidden = true), { once: true });
  }, 0);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
