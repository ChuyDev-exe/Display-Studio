import { icon } from './svg-icons.js';

export const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Diálogo modal sobre <dialog>: foco atrapado, Escape y clic en el fondo para cerrar.
 * Por defecto se elimina del DOM al cerrarse; con `persistent` se conserva para reabrirlo.
 */
export function createModal({ title, size = 'max-w-3xl', persistent = false, bodyClass = 'p-4', footer = true, onClose }) {
  const dialog = document.createElement('dialog');
  dialog.className = `m-auto w-[95vw] ${size} rounded-xl border border-ink-600 bg-ink-900 p-0 text-slate-200 shadow-[0_24px_64px_-12px_rgba(0,0,0,0.6)]`;
  dialog.innerHTML = `
    <div class="flex max-h-[88vh] flex-col">
      <header class="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-ink-600 pl-4 pr-2">
        <h2 data-title class="truncate text-[13px] font-semibold text-white"></h2>
        <button type="button" data-close class="btn btn-ghost btn-icon" aria-label="Cerrar">${icon('close')}</button>
      </header>
      <div data-body class="min-h-0 flex-1 overflow-y-auto ${bodyClass}"></div>
      ${footer ? '<footer data-footer class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-ink-600 px-4 py-2.5"></footer>' : ''}
    </div>`;
  dialog.querySelector('[data-title]').textContent = title;
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  // Clic en el fondo: solo si el gesto empieza y termina fuera del contenido (evita cerrar al arrastrar un slider).
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', (e) => (downOnBackdrop = e.target === dialog));
  dialog.addEventListener('click', (e) => downOnBackdrop && e.target === dialog && dialog.close());
  dialog.addEventListener('close', () => {
    onClose?.();
    if (!persistent) dialog.remove();
  });
  document.body.append(dialog);
  return {
    dialog,
    body: dialog.querySelector('[data-body]'),
    footer: dialog.querySelector('[data-footer]'),
    setTitle: (text) => (dialog.querySelector('[data-title]').textContent = text),
    open: () => dialog.open || dialog.showModal(),
    close: () => dialog.close(),
  };
}

/** Botón para pies de modal. */
export function modalButton(label, className, handler) {
  const el = Object.assign(document.createElement('button'), { type: 'button', className: `btn ${className}`.trim(), textContent: label });
  if (handler) el.addEventListener('click', handler);
  return el;
}

/** Confirmación con dos botones; resuelve true si el usuario acepta. */
export function confirmModal({ title, message, confirmLabel = 'Aceptar', danger = false }) {
  return new Promise((resolve) => {
    let accepted = false;
    const modal = createModal({ title, size: 'max-w-sm', onClose: () => resolve(accepted) });
    const p = document.createElement('p');
    p.className = 'text-[13px] leading-relaxed text-slate-300';
    p.textContent = message;
    modal.body.append(p);
    const ok = modalButton(confirmLabel, danger ? 'btn-danger !border-red-400/40' : 'btn-primary', () => {
      accepted = true;
      modal.close();
    });
    modal.footer.append(modalButton('Cancelar', 'btn-ghost', modal.close), ok);
    modal.open();
    ok.focus();
  });
}
