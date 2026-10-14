import { logicalSize } from '../displays/display-configs.js';
import { DITHER_MODES } from '../displays/image-import.js';
import { compatibleDisplays, fetchFrames, parseFigmaUrl, renderFrames } from '../figma/figma-api.js';
import { figmaSettings } from '../figma/figma-settings.js';
import { panelPreview, renderDesign } from './design-import.js';
import { openFigmaSettings } from './figma-settings.js';
import { createModal, esc, modalButton } from './modal.js';
import { icon } from './svg-icons.js';

const DEFAULT_MS = 200;

/**
 * Modal "Importar de Figma": lee los frames de un archivo y lleva cada uno a las pantallas
 * gráficas en las que encaja (mismo tamaño, múltiplo entero o girado 90°), o a la que elija el usuario.
 *
 * @param opts.displays       configs de las pantallas gráficas registradas
 * @param opts.onApply(groups, mode)  groups = [{ config, rotation, items: [{ data, ms }] }], mode = 'replace' | 'append'
 * @param opts.onOpen(key, rotation)  abrir una pantalla al terminar
 */
export function openFigmaImport({ displays, onApply, onOpen, notify: report }) {
  const byKey = Object.fromEntries(displays.map((d) => [d.key, d]));
  const state = {
    step: 'connect', busy: false, progress: '', url: figmaSettings.url,
    error: '', file: null, frames: [], onlyCompatible: true, mode: 'replace', ditherMode: 'threshold', threshold: 128, result: [],
  };
  const modal = createModal({ title: 'Importar de Figma', size: 'max-w-4xl' });
  // Los avisos de la app quedan detrás del modal: el error también se muestra dentro.
  const notify = (message) => {
    state.error = message;
    report(message);
    render();
  };

  const targetLabel = ({ key, rotation, exact, scale }) => {
    const notes = [];
    if (rotation) notes.push('girada 90°');
    if (exact && scale < 1) notes.push(`${Math.round(1 / scale)}x`);
    if (!exact) notes.push('ajustar');
    return `${esc(byKey[key].label)}${notes.length ? ` <span class="text-slate-500">· ${notes.join(' · ')}</span>` : ''}`;
  };

  const render = () => {
    modal.setTitle(state.file ? `Importar de Figma · ${state.file}` : 'Importar de Figma');
    const error = state.error
      ? `<p role="alert" class="mb-3 flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-400/[.06] px-3 py-2 text-xs text-red-200">${icon('alert', 'mt-px h-3.5 w-3.5')}${esc(state.error)}</p>`
      : '';
    modal.body.innerHTML = error + { connect: connectHtml, frames: framesHtml, done: doneHtml }[state.step]();
    modal.footer.replaceChildren(...footer());
    bind();
    if (state.step === 'done') paintResults();
  };

  // ------------------------------------------------------------------ paso 1

  const connectHtml = () => `
    <form data-ref="connect" class="mx-auto max-w-xl space-y-4">
      <p class="text-[13px] leading-relaxed text-slate-300">Pega el enlace de un archivo de Figma. Cada frame cuyo tamaño coincida con una pantalla (por ejemplo 240 x 240 para el GC9A01 o 128 x 64 para el SSD1306) se carga en esa pantalla como fotograma.</p>
      <div><label class="field-label" for="fg-url">Enlace del archivo, página o frame</label>
        <input id="fg-url" data-ref="url" class="input" type="url" required placeholder="https://www.figma.com/design/…" value="${esc(state.url)}" autocomplete="off" spellcheck="false" /></div>
      ${accountHtml()}
      ${state.busy ? `<p class="text-xs text-slate-400">${esc(state.progress)}</p>` : ''}
    </form>`;

  const accountHtml = () => {
    const user = figmaSettings.user;
    return figmaSettings.token
      ? `<p class="flex items-center gap-2 text-2xs text-slate-500">${icon('check', 'h-3 w-3 text-emerald-300')}Figma configurado${user ? ` como <span class="text-slate-300">${esc(user)}</span>` : ''}.
          <button type="button" data-ref="settings" class="text-accent hover:text-accent-strong">Cambiar token</button></p>`
      : `<div class="flex flex-wrap items-center gap-3 rounded-lg border border-amber-400/30 bg-amber-400/[.06] px-3 py-2 text-xs text-amber-100">
          ${icon('alert', 'h-3.5 w-3.5')}<span class="flex-1">Falta conectar tu cuenta de Figma con un token de acceso.</span>
          <button type="button" data-ref="settings" class="btn">${icon('settings', 'h-3.5 w-3.5')}Configurar Figma</button></div>`;
  };

  const settings = (tab = 'connect') => openFigmaSettings({ displays, tab, onSaved: () => {
    state.url ||= figmaSettings.url;
    if (state.step === 'connect') render();
  } });

  async function connect() {
    const target = parseFigmaUrl(state.url);
    if (!target) return notify('El enlace no parece de un archivo de Figma (figma.com/design/…).');
    if (!figmaSettings.token) return settings();
    figmaSettings.url = state.url;
    setBusy(true, 'Leyendo el archivo…');
    try {
      const { name, frames } = await fetchFrames(target, figmaSettings.token);
      state.target = target;
      state.file = name;
      state.frames = frames.map((frame) => {
        const targets = compatibleDisplays(frame, displays).map((t) => ({ ...t, on: t.exact }));
        return { ...frame, targets };
      });
      if (!state.frames.length) throw new Error('No se encontraron frames en ese archivo o nodo.');
      state.onlyCompatible = state.frames.some(hasExact);
      state.step = 'frames';
    } catch (error) {
      notify(error.message);
    }
    setBusy(false);
  }

  // ------------------------------------------------------------------ paso 2

  const hasExact = (frame) => frame.targets.some((t) => t.exact);
  const selectedTargets = () => state.frames.flatMap((frame) => frame.targets.filter((t) => t.on).map((t) => ({ frame, target: t })));

  const framesHtml = () => {
    const visible = state.frames.filter((f) => !state.onlyCompatible || hasExact(f) || f.targets.some((t) => t.on));
    const hidden = state.frames.length - visible.length;
    const anyMono = selectedTargets().some(({ target }) => byKey[target.key].type === 'mono');
    return `
      <div class="space-y-3">
        <div class="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div><span class="field-label">Fotogramas de cada pantalla</span>
            <div class="seg" role="radiogroup" aria-label="Fotogramas existentes">
              <button type="button" role="radio" data-mode="replace" aria-checked="${state.mode === 'replace'}">Reemplazar</button>
              <button type="button" role="radio" data-mode="append" aria-checked="${state.mode === 'append'}">Añadir al final</button>
            </div></div>
          ${anyMono ? `<div><label class="field-label" for="fg-dither">Reducción a 1 bit</label>
            <select id="fg-dither" data-ref="dither" class="input !w-auto">${DITHER_MODES.map(([id, label]) => `<option value="${id}" ${id === state.ditherMode ? 'selected' : ''}>${label}</option>`).join('')}</select></div>` : ''}
          <label class="ml-auto flex items-center gap-2 pb-1 text-xs text-slate-300"><input data-ref="only" type="checkbox" ${state.onlyCompatible ? 'checked' : ''} />Solo frames compatibles</label>
        </div>
        <ul class="space-y-1.5">${visible.map((frame) => frameRow(frame, state.frames.indexOf(frame))).join('')}</ul>
        ${hidden ? `<p class="text-2xs text-slate-500">${hidden} frame${hidden === 1 ? '' : 's'} sin pantalla del mismo tamaño. Desmarca "Solo frames compatibles" para asignarlos a mano (se ajustan al lienzo).</p>` : ''}
        ${!visible.length ? `<p class="rounded-lg border border-ink-600 bg-ink-950 px-3 py-4 text-center text-xs text-slate-400">Ningún frame mide lo mismo que una pantalla registrada. Crea en Figma frames del tamaño del panel, o asígnalos a mano.</p>` : ''}
      </div>`;
  };

  const frameRow = (frame, i) => {
    const used = new Set(frame.targets.map((t) => t.key));
    const others = displays.filter((d) => !used.has(d.key));
    return `
      <li class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-ink-600 bg-ink-950 px-3 py-2">
        <div class="min-w-[10rem] flex-1">
          <p class="truncate text-[13px] text-slate-200" title="${esc(frame.name)}">${esc(frame.name)}</p>
          <p class="text-2xs tabular-nums text-slate-500">${frame.page ? `${esc(frame.page)} · ` : ''}${frame.width} x ${frame.height} px</p>
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          ${frame.targets.map((t, j) => `<button type="button" data-frame="${i}" data-target="${j}" aria-pressed="${t.on}" class="flex h-7 items-center gap-1 rounded-md border border-ink-600 px-2 text-2xs text-slate-400 transition-colors hover:border-ink-500 aria-pressed:border-accent/60 aria-pressed:bg-accent-soft aria-pressed:text-slate-100">${t.on ? icon('check', 'h-3 w-3') : ''}${targetLabel(t)}</button>`).join('')}
          ${others.length ? `<select data-add="${i}" class="input !h-7 !w-auto !py-0 text-2xs" aria-label="Asignar a otra pantalla">
            <option value="">+ Pantalla</option>${others.map((d) => `<option value="${esc(d.key)}">${esc(d.label)} (${d.width} x ${d.height})</option>`).join('')}</select>` : ''}
        </div>
      </li>`;
  };

  async function importSelected() {
    const picks = selectedTargets();
    if (!picks.length) return notify('Marca al menos una pantalla para algún frame.');
    setBusy(true, 'Pidiendo a Figma que renderice los frames…');
    try {
      const jobs = picks.map(({ frame, target }) => {
        const { width: W, height: H } = logicalSize(byKey[target.key], target.rotation);
        // Exacto: se pide ya a la resolución del panel. Ajustado: lo bastante grande para no perder detalle.
        const scale = target.exact ? target.scale : Math.min(4, Math.max(W / frame.width, H / frame.height));
        return { id: frame.id, scale };
      });
      const bitmaps = await renderFrames(state.target.fileKey, jobs, figmaSettings.token, (done, total) => {
        state.progress = `Descargando ${done} de ${total}…`;
        const p = modal.body.querySelector('[data-ref=progress]');
        if (p) p.textContent = state.progress;
      });

      const groups = new Map();
      picks.forEach(({ target }, n) => {
        const config = byKey[target.key];
        const { width: W, height: H } = logicalSize(config, target.rotation);
        const bitmap = bitmaps[n];
        const source = { source: bitmap, width: bitmap.width, height: bitmap.height };
        const fit = target.exact ? (bitmap.width === W && bitmap.height === H ? 'pixel' : 'stretch') : 'contain';
        const data = renderDesign(source, W, H, { fit, mono: config.type === 'mono', ditherMode: state.ditherMode, threshold: state.threshold });
        const id = `${config.key}:${target.rotation}`;
        if (!groups.has(id)) groups.set(id, { config, rotation: target.rotation, items: [] });
        groups.get(id).items.push({ data, ms: DEFAULT_MS });
      });
      state.result = [...groups.values()];
      onApply(state.result, state.mode);
      bitmaps.forEach((b) => b.close?.());
      state.step = 'done';
    } catch (error) {
      notify(error.message);
    }
    setBusy(false);
  }

  // ------------------------------------------------------------------ paso 3

  const doneHtml = () => `
    <div class="space-y-3">
      <p class="text-[13px] text-slate-300">Listo. Cada pantalla tiene ya sus fotogramas; así se verán en el panel real:</p>
      <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${state.result.map((group, i) => `
        <li class="flex flex-col gap-2 rounded-lg border border-ink-600 bg-ink-950 p-3">
          <div class="bench grid h-36 place-items-center rounded-md border border-ink-600 p-2"><canvas data-result="${i}" class="pixelated block" aria-label="Vista previa en ${esc(group.config.label)}"></canvas></div>
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0"><p class="truncate text-xs text-slate-200">${esc(group.config.label)}${group.rotation ? ' · girada 90°' : ''}</p>
              <p class="text-2xs text-slate-500">${group.items.length} fotograma${group.items.length === 1 ? '' : 's'}</p></div>
            <button type="button" data-open="${i}" class="btn">${icon('arrow-right', 'h-3.5 w-3.5')}Abrir</button>
          </div>
        </li>`).join('')}</ul>
    </div>`;

  const paintResults = () => {
    modal.body.querySelectorAll('[data-result]').forEach((canvas) => {
      const { config, items } = state.result[Number(canvas.dataset.result)];
      const image = items[0].data;
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext('2d').putImageData(panelPreview(config, image), 0, 0);
      const scale = Math.min(200 / image.width, 120 / image.height);
      canvas.style.width = `${Math.floor(image.width * scale)}px`;
      canvas.style.height = `${Math.floor(image.height * scale)}px`;
    });
  };

  // ---------------------------------------------------------------- común

  function footer() {
    if (state.step === 'connect') {
      const go = modalButton('', 'btn-accent', () => modal.body.querySelector('[data-ref=connect]').requestSubmit());
      go.innerHTML = `${icon('arrow-right', 'h-3.5 w-3.5')}Buscar frames`;
      go.disabled = state.busy || !figmaSettings.token;
      const guide = modalButton('', 'btn-ghost mr-auto', () => settings('guide'));
      guide.innerHTML = `${icon('info', 'h-3.5 w-3.5')}Cómo preparar el diseño`;
      return [guide, modalButton('Cancelar', 'btn-ghost', modal.close), go];
    }
    if (state.step === 'frames') {
      const count = selectedTargets().length;
      const back = modalButton('Cambiar archivo', 'btn-ghost', () => { state.step = 'connect'; render(); });
      const go = modalButton('', 'btn-accent', importSelected);
      go.innerHTML = `${icon('download', 'h-3.5 w-3.5')}Importar${count ? ` (${count})` : ''}`;
      go.disabled = state.busy || !count;
      const status = document.createElement('span');
      status.dataset.ref = 'progress';
      status.className = 'mr-auto text-2xs text-slate-500';
      status.textContent = state.busy ? state.progress : '';
      return [status, back, go];
    }
    return [modalButton('Cerrar', 'btn-primary', modal.close)];
  }

  function setBusy(busy, progress = '') {
    if (busy) state.error = '';
    state.busy = busy;
    state.progress = progress;
    render();
  }

  function bind() {
    const $ = (s) => modal.body.querySelector(s);
    const form = $('[data-ref=connect]');
    if (form) {
      form.addEventListener('submit', (e) => { e.preventDefault(); if (!state.busy) connect(); });
      $('[data-ref=url]').addEventListener('input', (e) => (state.url = e.target.value));
      $('[data-ref=settings]').addEventListener('click', () => settings());
      $('[data-ref=url]').focus();
    }
    modal.body.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { state.mode = b.dataset.mode; render(); }));
    $('[data-ref=dither]')?.addEventListener('change', (e) => (state.ditherMode = e.target.value));
    $('[data-ref=only]')?.addEventListener('change', (e) => { state.onlyCompatible = e.target.checked; render(); });
    modal.body.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () => {
      if (state.busy) return;
      const target = state.frames[Number(b.dataset.frame)].targets[Number(b.dataset.target)];
      target.on = !target.on;
      render();
    }));
    modal.body.querySelectorAll('[data-add]').forEach((select) => select.addEventListener('change', () => {
      const frame = state.frames[Number(select.dataset.add)];
      const config = byKey[select.value];
      if (!config || state.busy) return;
      // Orientación que mejor respeta la proporción del frame.
      const portrait = frame.height > frame.width;
      const rotation = config.width !== config.height && portrait !== config.height > config.width ? 1 : 0;
      frame.targets.push({ key: config.key, rotation, exact: false, scale: 1, on: true });
      render();
    }));
    modal.body.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
      const { config, rotation } = state.result[Number(b.dataset.open)];
      modal.close();
      onOpen(config.key, rotation);
    }));
  }

  render();
  modal.open();
  if (!figmaSettings.token) settings();
}
