import { DISPLAYS, DISPLAY_ORDER, formatLabel } from '../displays/display-configs.js';
import { createModal, esc, modalButton } from './modal.js';
import { icon } from './svg-icons.js';

const sizeOf = (d) => (d.mode === 'character' ? `${d.cols} x ${d.rows}` : `${d.width} x ${d.height}`);

/** Silueta del panel a escala: rectángulo, círculo o módulo de caracteres. */
function silhouette(d) {
  const w = d.mode === 'character' ? d.cols * 6 : d.width;
  const h = d.mode === 'character' ? d.rows * 9 : d.height;
  const s = Math.min(28 / w, 20 / h);
  const sw = (w * s).toFixed(1);
  const sh = (h * s).toFixed(1);
  const shape = d.round
    ? `<ellipse cx="${sw / 2}" cy="${sh / 2}" rx="${sw / 2 - 0.75}" ry="${sh / 2 - 0.75}"/>`
    : `<rect x="0.75" y="0.75" width="${sw - 1.5}" height="${sh - 1.5}" rx="1.5"/>`;
  return `<svg width="${sw}" height="${sh}" viewBox="0 0 ${sw} ${sh}" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${shape}</svg>`;
}

/**
 * Selector de pantalla en un modal: lista agrupada, flechas para moverse y acciones de las
 * pantallas propias. Las acciones cierran el selector antes de abrir su propio diálogo.
 */
export function openDisplayPicker({ current, onSelect, onAdd, onEdit, onDelete }) {
  const modal = createModal({ title: 'Pantalla', size: 'max-w-md', bodyClass: 'p-2' });
  const groups = [...new Set(DISPLAY_ORDER.map((k) => DISPLAYS[k].group))];

  modal.body.innerHTML = `<div role="radiogroup" aria-label="Pantalla activa" class="space-y-3">${groups.map((group) => `
    <div><p class="px-2 pb-1 text-2xs font-medium text-slate-500">${esc(group)}</p>
      <div class="space-y-0.5">${DISPLAY_ORDER.filter((k) => DISPLAYS[k].group === group).map((key) => {
        const d = DISPLAYS[key];
        const on = key === current;
        return `<div class="group flex items-center gap-1 rounded-lg ${on ? 'bg-accent-soft' : 'hover:bg-white/[.04]'}">
          <button type="button" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-pick="${key}"
            class="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-left">
            <span class="grid h-7 w-9 shrink-0 place-items-center ${on ? 'text-accent' : 'text-slate-500'}">${silhouette(d)}</span>
            <span class="min-w-0 flex-1"><span class="block truncate text-[13px] ${on ? 'text-white' : 'text-slate-200'}">${esc(d.label)}</span>
              <span class="block truncate text-2xs text-slate-500">${sizeOf(d)} ${d.mode === 'character' ? 'caracteres' : 'px'}, ${esc(formatLabel(d))}${d.touch ? ', táctil' : ''}</span></span>
            ${on ? `<span class="text-accent">${icon('check', 'h-4 w-4')}</span>` : ''}
          </button>
          ${d.custom ? `<button type="button" data-edit="${key}" class="btn btn-ghost btn-icon opacity-60 group-hover:opacity-100" aria-label="Editar ${esc(d.label)}" title="Editar">${icon('pencil', 'h-3.5 w-3.5')}</button>
            <button type="button" data-delete="${key}" class="btn btn-ghost btn-icon mr-1 opacity-60 hover:!text-red-300 group-hover:opacity-100" aria-label="Eliminar ${esc(d.label)}" title="Eliminar">${icon('trash', 'h-3.5 w-3.5')}</button>` : ''}
        </div>`;
      }).join('')}</div></div>`).join('')}</div>`;

  const after = (fn) => () => {
    modal.close();
    fn();
  };
  modal.body.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) return after(() => onSelect(pick.dataset.pick))();
    const edit = e.target.closest('[data-edit]');
    if (edit) return after(() => onEdit(edit.dataset.edit))();
    const del = e.target.closest('[data-delete]');
    if (del) return after(() => onDelete(del.dataset.delete))();
  });
  modal.body.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step || !e.target.matches('[data-pick]')) return;
    e.preventDefault();
    const radios = [...modal.body.querySelectorAll('[data-pick]')];
    radios[(radios.indexOf(e.target) + step + radios.length) % radios.length].focus();
  });

  const add = modalButton('', '', after(onAdd));
  add.innerHTML = `${icon('plus', 'h-3.5 w-3.5')}Agregar pantalla`;
  modal.footer.classList.replace('justify-end', 'justify-between');
  const hint = document.createElement('span');
  hint.className = 'kbd-hint';
  hint.textContent = 'Flechas para moverte, Enter para elegir';
  modal.footer.append(hint, add);
  modal.open();
  modal.body.querySelector('[aria-checked=true]')?.focus();
}
