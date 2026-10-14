import { logicalSize } from '../displays/display-configs.js';
import { DITHER_MODES, decodeFile, dither, drawFit, fileKind } from '../displays/image-import.js';
import { nativePreview } from '../displays/native-format.js';
import { decodeMono1bpp, decodeRgb565LE, rgbaToMono1bpp, rgbaToRgb565LE } from '../displays/pixel-encoder.js';
import { PIXEL_FORMAT } from '../serial/protocol.js';
import { createModal, esc, modalButton } from './modal.js';
import { icon } from './svg-icons.js';

export const FITS = [
  ['pixel', 'Píxel a píxel'],
  ['contain', 'Contener'],
  ['cover', 'Cubrir'],
  ['stretch', 'Estirar'],
];

/** ¿El diseño cabe exacto (o a escala entera, como un export 2x de Figma)? */
export function pixelExact(src, W, H) {
  const k = src.width / W;
  return Number.isInteger(k) && k >= 1 && src.height === H * k;
}

/**
 * Diseño (Figma, PNG, SVG...) -> ImageData de W x H lista para el lienzo.
 * `pixel`: 1:1 si coincide el tamaño; a escala entera promediando cada bloque; si no, contener.
 */
export function renderDesign(src, W, H, { fit = 'pixel', mono = false, ditherMode = 'threshold', threshold = 128 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (fit === 'pixel' && pixelExact(src, W, H)) {
    ctx.imageSmoothingEnabled = src.width !== W; // 1:1 sin remuestreo; 2x/3x promediado
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src.source, 0, 0, W, H);
  } else {
    drawFit(ctx, src, W, H, fit === 'pixel' ? 'contain' : fit);
  }
  let image = ctx.getImageData(0, 0, W, H);
  if (mono) image = dither(image, ditherMode, threshold);
  return image;
}

/** Cómo se vería en el panel: cuantizado al formato real de la pantalla. */
export function panelPreview(config, image) {
  if (config.profile) {
    const colors = { on: config.previewOn, off: config.previewOff };
    return nativePreview(image, config.profile.pixel, colors);
  }
  const { width, height } = image;
  return config.format === PIXEL_FORMAT.RGB565_LE
    ? decodeRgb565LE(rgbaToRgb565LE(image), width, height)
    : decodeMono1bpp(rgbaToMono1bpp(image), width, height, config.previewOn, config.previewOff);
}

/** Lee lo que haya en el portapapeles: una imagen (Copiar como PNG) o texto SVG (Copiar como SVG). */
export function fileFromClipboard(event) {
  const items = [...(event.clipboardData?.items ?? [])];
  const image = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (image) {
    const file = image.getAsFile();
    return new File([file], file.name && file.name !== 'image.png' ? file.name : 'Diseño pegado.png', { type: file.type });
  }
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (/<svg[\s>]/i.test(text)) return new File([text], 'Diseño pegado.svg', { type: 'image/svg+xml' });
  return null;
}

/**
 * Bloque reutilizable (modal de importar y pestaña Diseño de "Agregar pantalla"):
 * zona para soltar o pegar, ajuste, tramado en mono y vista previa del panel.
 */
export function designPicker(root, { getTarget, state, onChange = () => {}, notify = () => {} }) {
  const render = () => {
    const { W, H, mono } = getTarget();
    const src = state.source;
    const exact = src && pixelExact(src, W, H);
    root.innerHTML = `
      <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_15rem]">
        <div class="space-y-3">
          <div data-ref="drop" tabindex="0" class="grid place-items-center gap-2 rounded-lg border border-dashed border-ink-500 px-4 py-6 text-center outline-none transition-colors focus-visible:border-accent">
            <span class="text-slate-500">${icon('layers', 'h-5 w-5')}</span>
            <p class="text-[13px] text-slate-200">${src ? esc(state.name) : 'Suelta, elige o pega un diseño'}</p>
            <p class="max-w-sm text-2xs leading-relaxed text-slate-500">${src ? `${src.width} x ${src.height} px` : 'PNG, JPG, WebP o SVG. Desde Figma: Exportar el frame en PNG a 1x, o Copiar como PNG / SVG y pegar aquí con Cmd+V.'}</p>
            <div class="flex gap-2">
              <label class="btn cursor-pointer">${icon('upload', 'h-3.5 w-3.5')}${src ? 'Cambiar' : 'Elegir archivo'}<input data-ref="file" type="file" accept="image/*,.svg" class="sr-only" /></label>
              ${src ? `<button type="button" data-ref="remove" class="btn btn-ghost">Quitar</button>` : ''}
            </div>
          </div>
          <div class="rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-2xs leading-relaxed text-slate-400">
            Para que cada píxel del diseño caiga en un píxel del panel, crea en Figma un frame de <span class="tabular-nums text-slate-200">${W} x ${H}</span> y expórtalo a 1x (o 2x, 3x: se promedia). ${mono ? (getTarget().config?.profile?.kind === 'epaper' ? 'En e-paper el blanco es papel y el negro es tinta.' : 'En pantallas de 1 bit usa colores puros: blanco enciende el píxel, negro lo apaga.') : ''}
          </div>
          ${src ? `<div class="flex flex-wrap items-end gap-x-4 gap-y-3">
            <div><span class="field-label">Ajuste</span>
              <div class="seg" role="radiogroup" aria-label="Ajuste">${FITS.map(([id, label]) => `<button type="button" role="radio" data-fit="${id}" aria-checked="${state.fit === id}" ${id === 'pixel' && !exact ? 'disabled title="El diseño no mide ' + W + ' x ' + H + ' ni un múltiplo exacto"' : ''} class="disabled:opacity-40">${label}</button>`).join('')}</div></div>
            ${mono ? `<div><label class="field-label" for="dp-dither">Reducción a 1 bit</label>
              <select id="dp-dither" data-ref="dither" class="input !w-auto">${DITHER_MODES.map(([id, label]) => `<option value="${id}" ${id === state.ditherMode ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
              <div class="min-w-[9rem]"><div class="flex justify-between"><label class="field-label" for="dp-th">Umbral</label><output data-ref="th-out" class="text-2xs tabular-nums text-slate-400">${state.threshold}</output></div>
              <input id="dp-th" data-ref="threshold" type="range" min="16" max="240" value="${state.threshold}" class="w-full" /></div>` : ''}
          </div>` : ''}
        </div>
        <div class="space-y-2">
          <div class="bench grid h-52 place-items-center rounded-lg border border-ink-600 p-3">
            <canvas data-ref="preview" class="pixelated block" aria-label="Vista previa en el panel"></canvas>
          </div>
          <p data-ref="info" class="text-2xs leading-snug text-slate-500">${src ? `Así se verá en el panel (${W} x ${H}).` : 'La vista previa aparece al cargar un diseño.'}</p>
        </div>
      </div>`;
    bind();
    paint();
  };

  const paint = () => {
    const canvas = root.querySelector('[data-ref=preview]');
    if (!canvas || !state.source) return;
    const { W, H, mono, config } = getTarget();
    if (state.fit === 'pixel' && !pixelExact(state.source, W, H)) state.fit = 'contain';
    const image = renderDesign(state.source, W, H, { fit: state.fit, mono, ditherMode: state.ditherMode, threshold: state.threshold });
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d').putImageData(config ? panelPreview(config, image) : image, 0, 0);
    const scale = Math.min(208 / W, 184 / H);
    canvas.style.width = `${Math.floor(W * scale)}px`;
    canvas.style.height = `${Math.floor(H * scale)}px`;
  };

  const load = async (file) => {
    if (!file || !fileKind(file)) return notify('El archivo no es una imagen compatible (PNG, JPG, WebP, SVG).');
    try {
      const [first] = await decodeFile(file);
      const { W, H } = getTarget();
      Object.assign(state, { source: first, name: file.name, fit: pixelExact(first, W, H) ? 'pixel' : 'contain' });
      render();
      onChange();
    } catch (error) {
      notify(error.message);
    }
  };

  const bind = () => {
    const $ = (s) => root.querySelector(s);
    const drop = $('[data-ref=drop]');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('border-accent'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('border-accent'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); load([...e.dataTransfer.files][0]); });
    $('[data-ref=file]').addEventListener('change', (e) => load(e.target.files[0]));
    $('[data-ref=remove]')?.addEventListener('click', () => {
      Object.assign(state, { source: null, name: '' });
      render();
      onChange();
    });
    root.querySelectorAll('[data-fit]').forEach((b) => b.addEventListener('click', () => {
      state.fit = b.dataset.fit;
      root.querySelectorAll('[data-fit]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      paint();
    }));
    $('[data-ref=dither]')?.addEventListener('change', (e) => { state.ditherMode = e.target.value; paint(); });
    $('[data-ref=threshold]')?.addEventListener('input', (e) => {
      state.threshold = Number(e.target.value);
      $('[data-ref=th-out]').textContent = e.target.value;
      paint();
    });
  };

  render();
  return { render, load, image: () => {
    if (!state.source) return null;
    const { W, H, mono } = getTarget();
    return renderDesign(state.source, W, H, { fit: state.fit, mono, ditherMode: state.ditherMode, threshold: state.threshold });
  } };
}

/**
 * Modal "Importar diseño": un frame de Figma o una imagen a pantalla completa.
 * @param onApply(imageData, mode)  mode = 'replace' (fotograma actual) | 'append' (nuevo fotograma)
 */
export function openDesignImport({ config, rotation = 0, file = null, onApply, notify }) {
  const { width: W, height: H } = logicalSize(config, rotation);
  const mono = config.type === 'mono';
  const state = { source: null, name: '', fit: 'pixel', ditherMode: 'floyd', threshold: 128 };
  const modal = createModal({ title: 'Importar diseño', size: 'max-w-3xl' });
  const picker = designPicker(modal.body, { getTarget: () => ({ W, H, mono, config }), state, notify, onChange: () => sync() });

  const append = modalButton('Como fotograma nuevo', 'btn-ghost', () => finish('append'));
  const replace = modalButton('', 'btn-accent', () => finish('replace'));
  replace.innerHTML = `${icon('check', 'h-3.5 w-3.5')}Reemplazar fotograma`;
  modal.footer.append(modalButton('Cancelar', 'btn-ghost', modal.close), append, replace);
  const sync = () => (append.disabled = replace.disabled = !state.source);
  sync();

  function finish(mode) {
    const image = picker.image();
    if (!image) return;
    onApply(image, mode);
    modal.close();
  }

  modal.dialog.addEventListener('paste', (e) => {
    const pasted = fileFromClipboard(e);
    if (!pasted) return;
    e.preventDefault();
    picker.load(pasted);
  });
  modal.open();
  modal.body.querySelector('[data-ref=drop]').focus();
  if (file) picker.load(file);
}

