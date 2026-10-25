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

/**
 * Webview 内模态输入框（替代 window.prompt）。
 * VSCode webview 禁用原生 prompt()——调用会静默返回 null，
 * 导致「新建分支 / 添加远程仓库」等按钮点击无反应，必须自绘。
 * 用法：`const name = await promptValue('名称：', ''); if (!name) return;`
 */
export function promptValue(text: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
<div class="modal" role="dialog" aria-modal="true">
  <div class="modal-text"></div>
  <input class="modal-input" type="text" spellcheck="false">
  <div class="modal-btns">
    <button class="mini" data-act="cancel">取消</button>
    <button class="mini primary" data-act="ok">确定</button>
  </div>
</div>`;
    (overlay.querySelector('.modal-text') as HTMLElement).textContent = text;
    const input = overlay.querySelector('.modal-input') as HTMLInputElement;
    input.value = initial;
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      overlay.remove();
      resolve(value === null ? null : value.trim());
    };
    overlay.querySelector('[data-act="ok"]')!.addEventListener('click', () => finish(input.value));
    overlay.querySelector('[data-act="cancel"]')!.addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    });
    // 点击遮罩空白处视为取消（mousedown 起点在遮罩上才算，避免拖拽选中文本误关）
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) finish(null);
    });
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

/** 多字段模态输入框（替代「连续多个 window.prompt」的一步一步填写）。
 * 一次对话框内填写所有字段：Enter 跳到下一字段、最后一个字段回车提交，
 * Esc / 遮罩点击取消。返回各字段 trim 后的值数组；取消返回 null。
 */
export function promptFields(
  title: string,
  fields: Array<{ label: string; initial?: string; placeholder?: string }>,
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
<div class="modal" role="dialog" aria-modal="true">
  <div class="modal-text"></div>
  <div class="modal-fields">
    ${fields
      .map(
        (f, i) =>
          `<label class="modal-field"><span class="modal-field-label"></span><input class="modal-input" type="text" spellcheck="false" data-i="${i}"></label>`,
      )
      .join('')}
  </div>
  <div class="modal-btns">
    <button class="mini" data-act="cancel">取消</button>
    <button class="mini primary" data-act="ok">确定</button>
  </div>
</div>`;
    (overlay.querySelector('.modal-text') as HTMLElement).textContent = title;
    const inputs = [...overlay.querySelectorAll<HTMLInputElement>('.modal-input')];
    fields.forEach((f, i) => {
      inputs[i].value = f.initial ?? '';
      inputs[i].placeholder = f.placeholder ?? '';
      (overlay.querySelectorAll('.modal-field-label')[i] as HTMLElement).textContent = f.label;
    });
    let done = false;
    const finish = (value: string[] | null): void => {
      if (done) return;
      done = true;
      overlay.remove();
      resolve(value === null ? null : value.map((v) => v.trim()));
    };
    overlay.querySelector('[data-act="ok"]')!.addEventListener('click', () => finish(inputs.map((x) => x.value)));
    overlay.querySelector('[data-act="cancel"]')!.addEventListener('click', () => finish(null));
    inputs.forEach((input, i) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (i < inputs.length - 1) inputs[i + 1].focus();
          else finish(inputs.map((x) => x.value));
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      });
    });
    // 点击遮罩空白处视为取消（mousedown 起点在遮罩上才算，避免拖拽选中文本误关）
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) finish(null);
    });
    document.body.appendChild(overlay);
    inputs[0]?.focus();
    inputs[0]?.select();
  });
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
