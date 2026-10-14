import {
  BUS_LABELS, CONTROLLERS, CUSTOM_BUSES, DISPLAYS, MAX_SIDE, nextDisplayId, registerDisplay, slugKey, validateSpec,
} from '../displays/display-configs.js';
import {
  OTHER_DRIVER, TECHS, TOUCH_CONTROLLERS, TOUCH_TYPES, defaultTouch, driverInfo, driverProfile, inferTech, presetsFor, techInfo, touchInfo, touchLabel,
} from '../displays/display-catalog.js';
import { saveCustomDisplays } from '../displays/custom-displays.js';
import { NATIVE_FORMATS, formatInfo, nativeBytes } from '../displays/native-format.js';
import {
  DC_MODES, PANEL_KINDS, TEMPLATES, WINDOW_MODES, checkProfile, editorType, kindInfo, makeProfile, stepLine,
} from '../displays/profile.js';
import { designPicker } from './design-import.js';
import { createModal, esc, modalButton } from './modal.js';
import { icon } from './svg-icons.js';

const TABS = [
  ['general', 'General', 'monitor'],
  ['datasheet', 'Hoja de datos', 'upload'],
  ['protocol', 'Protocolo', 'bus'],
  ['sequences', 'Secuencias', 'terminal'],
  ['design', 'Diseño', 'layers'],
];
const H2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const hexText = (n) => (n == null ? '' : `0x${H2(n)}`);
const parseHex = (text) => {
  const t = String(text).trim();
  if (!t) return null;
  const m = t.match(/^(?:0x)?([0-9a-f]{1,2})h?$/i);
  return m ? parseInt(m[1], 16) : undefined;
};
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
const setPath = (obj, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
};

/** Modal para crear o editar una pantalla: integrada, o con protocolo propio leído de su hoja de datos. */
export function openDisplayModal({ editingKey = null, onSaved }) {
  const editing = editingKey ? DISPLAYS[editingKey] : null;
  const state = {
    spec: editing ? { ...structuredClone(editing.spec), ...inferTech(editing.spec) } : {
      label: '', tech: 'tft', driver: 'st7789', controller: 'st7789', id: nextDisplayId(), width: 240, height: 320, touch: null,
    },
    autoLabel: !editing, // el nombre se propone solo hasta que el usuario lo escribe
    tab: 'general',
    sheet: { status: 'idle', progress: '', result: null, apply: new Set(), filter: '', error: '' },
    design: { source: null, name: '', fit: 'pixel', ditherMode: 'floyd', threshold: 128 },
    flash: null, // aviso dentro del modal: { kind: 'info' | 'error', text }
  };
  const notify = (text, kind = 'error') => {
    state.flash = { kind, text };
    showFlash();
  };
  if (state.spec.controller === 'custom') state.spec.profile = makeProfile(state.spec.profile);

  const modal = createModal({ title: editing ? `Editar ${editing.label}` : 'Agregar pantalla', size: 'max-w-5xl', bodyClass: 'p-0 !overflow-hidden' });
  const save = modalButton(editing ? 'Guardar cambios' : 'Agregar pantalla', 'btn-accent');
  modal.footer.append(modalButton('Cancelar', 'btn-ghost', modal.close), save);
  modal.body.innerHTML = `
    <div class="grid h-[min(72vh,640px)] min-h-0 md:grid-cols-[minmax(0,1fr)_15rem]">
      <div class="flex min-h-0 flex-col">
        <div data-ref="tabs" class="flex shrink-0 gap-1 overflow-x-auto border-b border-ink-600 px-3" role="tablist"></div>
        <div data-ref="pane" class="min-h-0 flex-1 overflow-y-auto p-4"></div>
      </div>
      <aside data-ref="side" class="hidden min-h-0 space-y-3 overflow-y-auto border-l border-ink-600 p-3 md:block"></aside>
    </div>`;
  const $ = (s) => modal.body.querySelector(s);
  const custom = () => state.spec.controller === 'custom';
  const controller = () => CONTROLLERS[state.spec.controller];
  const character = () => controller().mode === 'character';
  const profile = () => state.spec.profile;

  // ------------------------------------------------------------- pestañas

  function renderTabs() {
    $('[data-ref=tabs]').innerHTML = TABS.map(([id, label, ico]) => {
      const off = (id === 'protocol' || id === 'sequences') && !custom();
      const hide = id === 'design' && character();
      if (hide) return '';
      return `<button type="button" role="tab" data-tab="${id}" aria-selected="${state.tab === id}" ${off ? 'disabled title="Disponible con Protocolo propio"' : ''} class="tab disabled:opacity-40">${icon(ico, 'h-3.5 w-3.5')}${label}</button>`;
    }).join('');
  }

  function renderPane() {
    renderTabs();
    const pane = $('[data-ref=pane]');
    pane.scrollTop = 0;
    ({ general, datasheet, protocol, sequences, design })[state.tab](pane);
    showFlash();
    refreshSide();
  }

  function showFlash() {
    const pane = $('[data-ref=pane]');
    pane.querySelector('[data-ref=flash]')?.remove();
    if (!state.flash) return;
    const el = document.createElement('div');
    el.dataset.ref = 'flash';
    el.className = `mb-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${state.flash.kind === 'error' ? 'border-red-400/30 bg-red-500/10 text-red-200' : 'border-accent/30 bg-accent/10 text-slate-200'}`;
    el.innerHTML = `<span class="mt-0.5 ${state.flash.kind === 'error' ? 'text-red-300' : 'text-accent'}">${icon(state.flash.kind === 'error' ? 'alert' : 'info', 'h-3.5 w-3.5')}</span><p class="flex-1"></p>
      <button type="button" class="btn btn-ghost btn-icon !h-5 !w-5" aria-label="Cerrar aviso">${icon('close', 'h-3 w-3')}</button>`;
    el.querySelector('p').textContent = state.flash.text;
    el.querySelector('button').addEventListener('click', () => { state.flash = null; el.remove(); });
    pane.prepend(el);
  }

  // ------------------------------------------------------------- campos

  const field = (label, control, hint = '') =>
    `<div><span class="field-label">${label}</span>${control}${hint ? `<p class="mt-1 text-2xs leading-snug text-slate-500">${hint}</p>` : ''}</div>`;
  const text = (path, attrs = '') => `<input class="input" data-bind="${path}" value="${esc(getPath(state, path) ?? '')}" ${attrs} />`;
  const num = (path, attrs = '') => `<input type="number" class="input tabular-nums" data-bind="${path}" data-type="int" value="${getPath(state, path) ?? ''}" ${attrs} />`;
  const hex = (path, placeholder = 'ninguno') => `<input class="input font-mono" data-bind="${path}" data-type="hex" value="${hexText(getPath(state, path))}" placeholder="${placeholder}" spellcheck="false" autocomplete="off" />`;
  const select = (path, options, { type = 'text', rerender = true } = {}) => {
    const value = getPath(state, path);
    return `<select class="input" data-bind="${path}" data-type="${type}" ${rerender ? 'data-rerender' : ''}>${options.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  };
  const check = (path, label, rerender = false) =>
    `<label class="flex h-7 items-center gap-2 text-xs text-slate-300"><input type="checkbox" data-bind="${path}" data-type="bool" ${getPath(state, path) ? 'checked' : ''} ${rerender ? 'data-rerender' : ''} />${label}</label>`;
  const section = (title, body, hint = '') => `<section class="space-y-3">
      <div><h3 class="text-xs font-semibold text-white">${title}</h3>${hint ? `<p class="mt-0.5 text-2xs text-slate-500">${hint}</p>` : ''}</div>${body}</section>`;

  // ------------------------------------------------------------- General

  /** Nombre propuesto: driver + resolución, p. ej. "ILI9488 320x480". */
  function suggestLabel() {
    const sp = state.spec;
    const driver = driverInfo(sp.tech, sp.driver);
    const name = driver ? driver.label.replace(/\s*\(.*\)$/, '') : sp.tech === 'other' ? 'Pantalla' : techInfo(sp.tech).label;
    return `${name} ${character() ? `${sp.cols}x${sp.rows}` : `${sp.width}x${sp.height}`}`.slice(0, 24);
  }

  /** Resoluciones sugeridas para el driver actual (las integradas traen las suyas). */
  function sizeOptions() {
    const sp = state.spec;
    const driver = driverInfo(sp.tech, sp.driver);
    return driver?.controller ? CONTROLLERS[driver.controller].presets : presetsFor(sp.tech, driver);
  }

  /** Aplica tecnología + driver: controlador integrado o protocolo propio desde su plantilla. */
  function applyDriver() {
    const sp = state.spec;
    const tech = techInfo(sp.tech);
    const driver = driverInfo(sp.tech, sp.driver);
    const id = driver?.controller ?? (tech.character ? 'hd44780' : 'custom');
    const ctrl = CONTROLLERS[id];
    sp.controller = id;
    // Se conserva el tamaño si es nativo del driver; un driver "Otro" respeta el que ya hubiera.
    const native = driver?.controller ? ctrl.presets : driver?.presets ?? null;
    const fallback = sizeOptions()[0];
    if (ctrl.mode === 'character') {
      if (!native.some(([c, r]) => c === sp.cols && r === sp.rows)) [sp.cols, sp.rows] = native[0];
      delete sp.width; delete sp.height;
    } else {
      if (native && !native.some(([w, h]) => w === sp.width && h === sp.height)) [sp.width, sp.height] = native[0];
      else if (!sp.width) [sp.width, sp.height] = fallback;
      delete sp.cols; delete sp.rows;
    }
    if (id === 'custom') {
      sp.profile = driverProfile(sp.tech, driver);
      sp.profile.name = driver ? driver.label.replace(/\s*\(.*\)$/, '') : '';
      delete sp.i2cAddr;
      sp.round = Boolean(sp.round && editorType(sp.profile) === 'tft');
    } else {
      delete sp.profile;
      sp.i2cAddr = ctrl.i2cAddr;
      sp.round = Boolean(ctrl.round);
    }
    if (ctrl.mode === 'character') sp.touch = null;
    if (state.autoLabel) sp.label = suggestLabel();
  }

  function general(pane) {
    const sp = state.spec;
    const tech = techInfo(sp.tech);
    const driver = driverInfo(sp.tech, sp.driver);
    const c = controller();
    const p = custom() ? profile() : null;
    const sizes = sizeOptions();
    const presets = sizes.map(([a, b]) => `<button type="button" data-preset="${a},${b}" aria-pressed="${character() ? a === sp.cols && b === sp.rows : a === sp.width && b === sp.height}" class="btn btn-ghost !h-6 !border-ink-600 !px-2 tabular-nums">${a} x ${b}</button>`).join('');
    const swatch = (colors) => `<span class="flex gap-0.5" aria-hidden="true">${colors.map((col) => `<span class="h-2.5 w-2.5 rounded-full border border-white/10" style="background:${col}"></span>`).join('')}</span>`;
    const templateLabel = custom() ? TEMPLATES[driver?.template ?? tech.template]?.label : '';

    const support = driver?.controller
      ? `<p class="flex items-start gap-2 text-2xs leading-relaxed text-emerald-200/90">${icon('check', 'mt-px h-3 w-3')}<span>Soporte integrado: el firmware de ejemplo ya lo maneja por USB.</span></p>`
      : tech.character ? ''
        : `<div class="flex flex-wrap items-start gap-2 rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-2xs leading-relaxed text-slate-400">
            <span class="mt-px text-accent">${icon('info', 'h-3 w-3')}</span>
            <p class="min-w-[12rem] flex-1">${driver
              ? `Se usa un protocolo propio con la plantilla <span class="text-slate-200">${esc(templateLabel)}</span>, ajustada para ${esc(driver.label)}. ${driver.note ? esc(driver.note) : 'Revisa los detalles en Protocolo y Secuencias.'}`
              : `Sirve cualquier driver. Se parte de la plantilla <span class="text-slate-200">${esc(templateLabel)}</span>: ajústala en Protocolo y Secuencias, o sube la hoja de datos y se rellenan solas.`}</p>
            <button type="button" data-goto="datasheet" class="btn !h-6 !px-2 text-2xs">${icon('upload', 'h-3 w-3')}Hoja de datos</button>
          </div>`;

    const touch = sp.touch;
    const tc = touch ? touchInfo(touch.controller) : null;
    const touchHtml = character() ? '' : section('Táctil', `
        <div class="seg" role="radiogroup" aria-label="Panel táctil">${TOUCH_TYPES.map(([id, label]) => `<button type="button" role="radio" data-touch="${id}" aria-checked="${(touch?.type ?? 'none') === id}">${label}</button>`).join('')}</div>
        ${touch ? `<div class="grid gap-3 sm:grid-cols-3">
          ${field('Controlador táctil', `<select id="d-touch-ctrl" class="input">${TOUCH_CONTROLLERS.filter((t) => t.type === touch.type || t.id === 'other').map((t) => `<option value="${t.id}" ${t.id === touch.controller ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>`)}
          ${tc.id === 'other' ? field('Nombre del chip', text('spec.touch.name', 'maxlength="24" placeholder="Ej. AXS15231" autocomplete="off"')) : ''}
          ${field('Interfaz', select('spec.touch.bus', [['i2c', 'I2C'], ['spi', 'SPI']]))}
          ${touch.bus === 'i2c' ? field('Dirección I2C', hex('spec.touch.addr', '0x38')) : ''}
          ${field('Puntos simultáneos', num('spec.touch.points', 'min="1" max="10"'))}
        </div>
        <div class="flex flex-wrap gap-x-5">${check('spec.touch.int', 'Pin INT (interrupción)')}${check('spec.touch.rst', 'Pin RESET del táctil')}</div>
        <p class="text-2xs leading-relaxed text-slate-500">${touch.type === 'cap'
          ? 'Capacitivo: el controlador da coordenadas ya calibradas por I2C; INT avisa de cada toque.'
          : 'Resistivo: hay que calibrar (leer las esquinas) y suele compartir el bus SPI con la pantalla, con su propio CS.'} Se exporta en ui_config.h como UI_TOUCH_*.</p>` : ''}`,
      'Si el módulo trae panel táctil, descríbelo para exportarlo con el resto de la configuración.');

    pane.innerHTML = `<div class="max-w-2xl space-y-6">
      ${section('Tipo de pantalla', `
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Tipo de pantalla">${TECHS.map((t) => `
          <button type="button" role="radio" data-tech="${t.id}" aria-checked="${t.id === sp.tech}"
            class="flex flex-col items-start gap-1.5 rounded-lg border border-ink-600 bg-ink-950 p-2.5 text-left transition-colors hover:border-ink-500 aria-checked:border-accent/70 aria-checked:bg-accent-soft">
            ${swatch(t.swatch)}
            <span class="text-xs font-medium text-slate-100">${esc(t.label)}</span>
            <span class="text-2xs leading-snug text-slate-500">${esc(t.desc)}</span>
          </button>`).join('')}
        </div>`)}

      ${section('Driver', `
        <div class="grid gap-3 sm:grid-cols-2">
          ${tech.drivers.length ? field('Controlador', `<select id="d-driver" class="input">
              ${tech.drivers.map((d) => `<option value="${d.id}" ${d.id === sp.driver ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}
              ${tech.character ? '' : `<option value="${OTHER_DRIVER}" ${!driver ? 'selected' : ''}>Otro / no sé cuál</option>`}</select>`) : ''}
          ${custom() && !driver ? field('Nombre del controlador (opcional)', text('spec.profile.name', 'maxlength="24" placeholder="Ej. JD9853, ST7735S…" autocomplete="off" spellcheck="false"')) : ''}
        </div>
        ${support}`)}

      ${section('Pantalla', `
        <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
          ${field('Nombre', text('spec.label', 'maxlength="24" placeholder="Ej. E-paper 2,9 pulgadas" autocomplete="off" id="d-name"'))}
          ${field('Diagonal (pulgadas)', `<input type="number" class="input tabular-nums" data-bind="spec.diagonal" data-type="float" value="${sp.diagonal ?? ''}" min="0.4" max="15" step="0.01" placeholder="Opcional" />`)}
        </div>`)}

      ${section(character() ? 'Columnas y filas' : 'Resolución', `
        <div class="flex flex-wrap gap-1">${presets}</div>
        <div class="grid max-w-xs grid-cols-2 gap-2">
          ${character()
            ? `${num('spec.cols', 'aria-label="Columnas" min="8" max="40"')}<select class="input" data-bind="spec.rows" data-type="int" aria-label="Filas">${[1, 2, 4].map((r) => `<option ${r === sp.rows ? 'selected' : ''}>${r}</option>`).join('')}</select>`
            : `${num('spec.width', `aria-label="Ancho" min="8" max="${MAX_SIDE}"`)}${num('spec.height', `aria-label="Alto" min="8" max="${MAX_SIDE}"`)}`}
        </div>
        ${character() ? '' : `<div class="flex flex-wrap gap-x-5">${check('spec.round', 'Panel redondo')}</div>`}`,
        character() ? '' : 'Resolución nativa del panel, sin rotar (la de la hoja de datos).')}

      ${sp.tech === 'other' && custom() ? section('Colores', `
        <div class="seg" role="radiogroup" aria-label="Tipo de panel">${PANEL_KINDS.map((k) => `<button type="button" role="radio" data-kind="${k.id}" aria-checked="${p.kind === k.id}">${k.label}</button>`).join('')}</div>`,
        'Decide los colores de la vista previa y el formato de píxel por defecto.') : ''}

      ${touchHtml}

      ${section('Firmware', `
        <div class="grid max-w-md gap-3 sm:grid-cols-2">
          ${field('ID para el firmware', num('spec.id', 'min="1" max="255"'))}
          ${!custom() && c.buses.includes('i2c') ? field('Dirección I2C', `<input class="input font-mono" data-bind="spec.i2cAddr" data-type="hex" value="${hexText(sp.i2cAddr ?? c.i2cAddr)}" />`) : ''}
        </div>`)}
    </div>`;

    pane.querySelectorAll('[data-tech]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.tech === sp.tech) return;
      sp.tech = b.dataset.tech;
      sp.driver = techInfo(sp.tech).drivers[0]?.id ?? OTHER_DRIVER;
      applyDriver();
      renderPane();
    }));
    pane.querySelector('#d-driver')?.addEventListener('change', (e) => {
      sp.driver = e.target.value;
      applyDriver();
      renderPane();
    });
    pane.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      const [a, z] = b.dataset.preset.split(',').map(Number);
      Object.assign(sp, character() ? { cols: a, rows: z } : { width: a, height: z });
      if (state.autoLabel) sp.label = suggestLabel();
      renderPane();
    }));
    pane.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
      const kind = b.dataset.kind;
      p.kind = kind;
      const fk = formatInfo(p.pixel.format).kind;
      if (['mono', 'lcd', 'epaper'].includes(kind) && fk !== 'mono') p.pixel.format = p.window.mode === 'pages' ? 'mono1-v' : 'mono1-h';
      if (kind === 'gray' && fk !== 'gray') p.pixel.format = 'gray4';
      if (kind === 'color' && fk !== 'color') p.pixel.format = 'rgb565';
      renderPane();
    }));
    pane.querySelectorAll('[data-touch]').forEach((b) => b.addEventListener('click', () => {
      const type = b.dataset.touch;
      if (type === (sp.touch?.type ?? 'none')) return;
      sp.touch = type === 'none' ? null : defaultTouch(type);
      renderPane();
    }));
    pane.querySelector('#d-touch-ctrl')?.addEventListener('change', (e) => {
      const t = touchInfo(e.target.value);
      Object.assign(sp.touch, { controller: t.id, bus: t.bus, addr: t.addr, points: t.points });
      renderPane();
    });
    pane.querySelector('[data-goto]')?.addEventListener('click', (e) => {
      state.tab = e.currentTarget.dataset.goto;
      renderPane();
    });
  }

  // ------------------------------------------------------------- Protocolo

  function protocol(pane) {
    const p = profile();
    const fk = formatInfo(p.pixel.format).kind;
    const win = p.window;
    pane.innerHTML = `<div class="space-y-6">
      <div class="flex flex-wrap items-end gap-2 rounded-lg border border-ink-600 bg-ink-950 p-3">
        <div class="min-w-[16rem] flex-1">${field('Partir de una plantilla', `<select id="d-template" class="input">${Object.entries(TEMPLATES).map(([id, t]) => `<option value="${id}">${esc(t.label)}</option>`).join('')}</select>`)}</div>
        <button type="button" data-ref="apply-template" class="btn">Aplicar plantilla</button>
        <p class="basis-full text-2xs text-slate-500">Reemplaza el protocolo y las secuencias; conserva nombre, resolución e ID.</p>
      </div>

      ${section('Interfaz', `
        <div class="flex flex-wrap gap-x-5">${CUSTOM_BUSES.map((b) => `<label class="flex h-7 items-center gap-2 text-xs text-slate-300"><input type="checkbox" data-bus="${b}" ${p.buses.includes(b) ? 'checked' : ''} />${BUS_LABELS[b]}</label>`).join('')}</div>
        <div class="grid gap-3 sm:grid-cols-3">
          ${field('Señal comando / dato', select('spec.profile.dc', DC_MODES.map((d) => [d.id, d.label])))}
          ${p.buses.includes('i2c') ? `${field('Dirección I2C (7 bits)', hex('spec.profile.i2cAddr', '0x3C'))}
            <div class="grid grid-cols-2 gap-2">${field('Control comando', hex('spec.profile.i2cCtrl.cmd', '0x00'))}${field('Control datos', hex('spec.profile.i2cCtrl.data', '0x40'))}</div>` : ''}
        </div>
        <div class="flex flex-wrap items-end gap-x-5 gap-y-2">
          ${check('spec.profile.reset', 'Pin RESET')}
          <div class="flex items-center gap-2 text-xs text-slate-300">Pin BUSY ${select('spec.profile.busy', [['', 'Sin pin'], ['high', 'Activo en alto'], ['low', 'Activo en bajo']], { type: 'nullable', rerender: false }).replace('class="input"', 'class="input !w-auto"')}</div>
        </div>`)}

      ${section('Píxeles', `
        <div class="grid gap-3 sm:grid-cols-3">
          ${field('Formato nativo', select('spec.profile.pixel.format', NATIVE_FORMATS.map((f) => [f.id, f.label])))}
          ${fk === 'color' ? `${field('Orden de color', select('spec.profile.pixel.bgr', [['false', 'RGB'], ['true', 'BGR']], { type: 'bool', rerender: false }))}
            ${p.pixel.format === 'rgb565' ? field('Bytes de cada píxel', select('spec.profile.pixel.lsbFirst', [['false', 'Alto primero (lo habitual)'], ['true', 'Bajo primero']], { type: 'bool', rerender: false })) : ''}`
            : field(fk === 'mono' ? 'Bit 1 significa' : 'Nivel máximo significa', select('spec.profile.pixel.bitOn', [['true', 'Píxel claro (blanco en el editor)'], ['false', 'Píxel oscuro (negro en el editor)']], { type: 'bool', rerender: false }),
              p.kind === 'epaper' ? 'En la mayoría de e-paper 1 = blanco (papel).' : fk === 'mono' ? 'En OLED, 1 = píxel encendido.' : '')}
        </div>`)}

      ${section('Direccionamiento de la RAM', `
        <div class="grid gap-3 sm:grid-cols-3">
          ${field('Modo', select('spec.profile.window.mode', WINDOW_MODES.map((w) => [w.id, w.label])))}
          ${win.mode !== 'pages' ? field('Escritura de RAM', hex('spec.profile.write'), 'Comando antes de los píxeles.') : ''}
        </div>
        ${win.mode === 'addr' ? `<div class="grid gap-3 sm:grid-cols-4">
          ${field('Columnas (X)', hex('spec.profile.window.col'))}
          ${field('Filas (Y)', hex('spec.profile.window.row'))}
          ${field('Contador X', hex('spec.profile.window.curX'))}
          ${field('Contador Y', hex('spec.profile.window.curY'))}
          ${field('Bytes por coordenada', select('spec.profile.window.coordBytes', [[1, '1 byte'], [2, '2 bytes']], { type: 'int', rerender: false }))}
          ${field('Orden de esos bytes', select('spec.profile.window.littleEndian', [['false', 'Alto primero'], ['true', 'Bajo primero']], { type: 'bool', rerender: false }))}
          ${field('Unidad de X', select('spec.profile.window.xUnit', [['px', 'Píxeles'], ['byte', 'Bytes de 8 px']]))}
          ${win.xUnit === 'byte' ? field('Bytes de X', select('spec.profile.window.xBytes', [[1, '1 byte'], [2, '2 bytes']], { type: 'int', rerender: false })) : '<div></div>'}
          ${field('Desplazamiento X', num('spec.profile.window.offsetX', 'min="0" max="511"'))}
          ${field('Desplazamiento Y', num('spec.profile.window.offsetY', 'min="0" max="511"'))}
        </div>` : ''}
        ${win.mode === 'pages' ? `<div class="grid gap-3 sm:grid-cols-4">
          ${field('Página (base)', hex('spec.profile.window.page', '0xB0'))}
          ${field('Columna, nibble bajo', hex('spec.profile.window.colLow', '0x00'))}
          ${field('Columna, nibble alto', hex('spec.profile.window.colHigh', '0x10'))}
          ${field('Columna inicial', num('spec.profile.window.offsetX', 'min="0" max="255"'), 'SH1106: 2')}
        </div>` : ''}`, win.mode === 'addr' ? 'Las coordenadas se envían como inicio y fin. Los contadores (e-paper) se ponen al inicio.' : '')}

      ${section('Brillo y rotación', `
        <div class="grid gap-3 sm:grid-cols-4">
          ${field('Brillo', hex('spec.profile.brightness.cmd', 'por PWM'))}
          ${field('Valor máximo', num('spec.profile.brightness.max', 'min="1" max="255" placeholder="255"'))}
          ${field('Rotación', hex('spec.profile.rotate.cmd', 'por software'))}
          ${field('Valores 0/90/180/270', `<input class="input font-mono" data-ref="rot-values" value="${(p.rotate?.values ?? []).map(H2).join(' ')}" placeholder="00 60 C0 A0" spellcheck="false" />`)}
        </div>`, 'Vacíos: el brillo va por PWM y la rotación se hace girando el framebuffer.')}
    </div>`;

    pane.querySelector('[data-ref=apply-template]').addEventListener('click', () => {
      const t = TEMPLATES[pane.querySelector('#d-template').value];
      state.spec.profile = makeProfile({ ...t.profile, name: profile().name, source: profile().source });
      renderPane();
    });
    pane.querySelectorAll('[data-bus]').forEach((el) => el.addEventListener('change', () => {
      const buses = new Set(p.buses);
      if (el.checked) buses.add(el.dataset.bus);
      else buses.delete(el.dataset.bus);
      p.buses = CUSTOM_BUSES.filter((b) => buses.has(b));
      if (p.buses.length === 1 && p.buses[0] === 'i2c') p.dc = 'i2c';
      renderPane();
    }));
    pane.querySelector('[data-ref=rot-values]').addEventListener('change', (e) => {
      const values = e.target.value.trim().split(/[\s,]+/).filter(Boolean).map(parseHex);
      if (values.length === 4 && values.every((v) => v != null)) {
        p.rotate = { cmd: p.rotate?.cmd ?? null, values };
        e.target.classList.remove('!border-red-400/60');
      } else e.target.classList.add('!border-red-400/60');
      refreshSide();
    });
  }

  // ------------------------------------------------------------- Secuencias

  function sequences(pane) {
    const area = (path, label, rows, hint) => `<div class="flex min-w-0 flex-col">
      <label class="field-label" for="seq-${path}">${label}</label>
      <textarea id="seq-${path}" data-bind="spec.profile.${path}" rows="${rows}" spellcheck="false" class="input min-h-0 flex-1 resize-y font-mono !text-[12px] leading-5">${esc(profile()[path] ?? '')}</textarea>
      <p data-status="${path}" class="mt-1 text-2xs text-slate-500">${hint}</p></div>`;
    pane.innerHTML = `<div class="space-y-4">
      <div class="grid gap-4 lg:grid-cols-2">
        ${area('init', 'Arranque', 16, '')}
        ${area('update', 'Después de escribir la RAM (refresco)', 16, '')}
      </div>
      <div class="rounded-lg border border-ink-600 bg-ink-950 p-3 text-2xs leading-relaxed text-slate-400">
        <p class="mb-1 text-xs font-medium text-slate-200">Formato</p>
        <p>Una línea por comando: el primer byte es el comando y el resto sus parámetros, en hexadecimal: <code class="text-slate-200">3A 55</code>, <code class="text-slate-200">0x3A, 0x55</code> o <code class="text-slate-200">3Ah 55h</code>.</p>
        <p><code class="text-slate-200">delay 120</code> espera en ms, <code class="text-slate-200">busy</code> espera al pin BUSY, <code class="text-slate-200">reset</code> da un pulso en RESET. Comentarios con <code class="text-slate-200">#</code> o <code class="text-slate-200">//</code>.</p>
        <p>Los comandos que encuentre la hoja de datos se pueden añadir desde la pestaña Hoja de datos.</p>
      </div>
    </div>`;
    seqStatus();
  }

  function seqStatus() {
    if (!custom()) return;
    const { init, update } = checkProfile(profile());
    for (const [key, result] of [['init', init], ['update', update]]) {
      const el = $(`[data-status=${key}]`);
      if (!el) continue;
      const commands = result.steps.filter((s) => s.cmd != null).length;
      const waits = result.steps.reduce((ms, s) => ms + s.delay, 0);
      el.innerHTML = result.errors.length
        ? result.errors.slice(0, 3).map((e) => `<span class="block text-red-300">${esc(e.message)}</span>`).join('')
        : `${commands} comando${commands === 1 ? '' : 's'}${waits ? `, ${waits} ms de esperas` : ''}${result.steps.some((s) => s.busy) ? ', espera BUSY' : ''}`;
    }
  }

  // ------------------------------------------------------------- Hoja de datos

  function datasheet(pane) {
    const sheet = state.sheet;
    if (sheet.status === 'idle' || sheet.status === 'error') {
      pane.innerHTML = `<div class="mx-auto max-w-lg space-y-3 pt-4">
        <div data-ref="sheet-drop" class="grid place-items-center gap-3 rounded-xl border border-dashed border-ink-500 px-6 py-10 text-center transition-colors">
          <span class="text-accent">${icon('upload', 'h-6 w-6')}</span>
          <div><p class="text-[13px] font-medium text-white">Sube la hoja de datos o el manual de referencia</p>
            <p class="mt-1 text-xs text-slate-400">PDF del controlador o del módulo. Se lee aquí, en tu navegador: no se envía a internet.</p></div>
          <label class="btn btn-accent cursor-pointer">${icon('upload', 'h-3.5 w-3.5')}Elegir PDF<input data-ref="sheet-file" type="file" accept=".pdf,application/pdf,.txt,.md" class="sr-only" /></label>
        </div>
        ${sheet.status === 'error' ? `<p class="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">${esc(sheet.error)}</p>` : ''}
        <p class="text-2xs leading-relaxed text-slate-500">Se buscan el controlador, la resolución, las interfaces, la dirección I2C, la profundidad de color y la tabla de comandos. Al aplicar, la pantalla pasa a Protocolo propio con lo encontrado; revisa después los parámetros de las secuencias. Los PDF escaneados (imagen sin texto) no se pueden leer.</p>
      </div>`;
      const drop = pane.querySelector('[data-ref=sheet-drop]');
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('border-accent'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('border-accent'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); readSheet([...e.dataTransfer.files][0]); });
      pane.querySelector('[data-ref=sheet-file]').addEventListener('change', (e) => readSheet(e.target.files[0]));
      return;
    }
    if (sheet.status === 'reading') {
      pane.innerHTML = `<div class="grid h-full place-items-center"><div class="w-64 space-y-2 text-center">
        <p class="text-xs text-slate-300">Leyendo la hoja de datos</p>
        <div class="h-1 overflow-hidden rounded-full bg-ink-700"><div data-ref="sheet-bar" class="h-full w-0 bg-accent transition-[width]"></div></div>
        <p data-ref="sheet-progress" class="text-2xs tabular-nums text-slate-500">${esc(sheet.progress)}</p></div></div>`;
      return;
    }
    const r = sheet.result;
    const shown = r.commands.filter((c) => !sheet.filter || `${H2(c.code)} ${c.name}`.toLowerCase().includes(sheet.filter.toLowerCase()));
    const ROLE_LABEL = { colAddr: 'columnas', rowAddr: 'filas', curX: 'contador X', curY: 'contador Y', memWrite: 'escritura', masterAct: 'refresco', refresh: 'refresco', updCtrl2: 'refresco', swreset: 'reset', sleepOut: 'arranque', displayOn: 'arranque', colmod: 'formato', madctl: 'rotación', brightness: 'brillo', contrast: 'brillo' };
    pane.innerHTML = `<div class="space-y-5">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-accent">${icon('check', 'h-4 w-4')}</span>
        <p class="min-w-0 flex-1 truncate text-xs text-slate-300"><span class="font-medium text-white">${esc(r.source.file)}</span>, ${r.source.pages} página${r.source.pages === 1 ? '' : 's'}${r.source.totalPages > r.source.pages ? ` de ${r.source.totalPages}` : ''}, ${r.commands.length} comandos encontrados</p>
        <button type="button" data-ref="sheet-reset" class="btn btn-ghost">Cambiar archivo</button>
      </div>
      <section class="space-y-2">
        <div class="flex items-center justify-between gap-2"><h3 class="text-xs font-semibold text-white">Lo que se encontró</h3>
          <button type="button" data-ref="sheet-apply" class="btn btn-accent">${icon('check', 'h-3.5 w-3.5')}Aplicar selección</button></div>
        <div class="divide-y divide-ink-700 rounded-lg border border-ink-600">
          ${r.fields.map((f) => `<label class="grid cursor-pointer grid-cols-[1.25rem_9rem_minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 text-xs ${f.found ? '' : 'opacity-50'}">
            <input type="checkbox" data-apply="${f.key}" ${state.sheet.apply.has(f.key) ? 'checked' : ''} ${f.found && f.key !== 'family' ? '' : 'disabled'} />
            <span class="text-slate-400">${f.label}</span>
            <span class="truncate ${f.found ? 'text-slate-100' : 'text-slate-500'}" title="${esc(f.value ?? '')}">${esc(f.value ?? 'No encontrado')}</span>
            <span class="text-2xs tabular-nums text-slate-500" title="${esc(f.evidence?.text ?? '')}">${f.evidence ? `p. ${f.evidence.page}` : ''}</span>
          </label>`).join('')}
        </div>
        <p class="text-2xs text-slate-500">Pasa el cursor sobre el número de página para ver la línea de donde salió cada dato.</p>
      </section>
      <section class="space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2"><h3 class="text-xs font-semibold text-white">Tabla de comandos</h3>
          <input data-ref="sheet-filter" class="input !w-56" placeholder="Filtrar: 2A, reset, RAM" value="${esc(sheet.filter)}" /></div>
        <div class="max-h-64 overflow-y-auto rounded-lg border border-ink-600">
          <table class="w-full text-left text-xs"><tbody class="divide-y divide-ink-700">
            ${shown.map((c) => `<tr class="hover:bg-white/[.03]">
              <td class="w-14 px-3 py-1 font-mono text-accent-strong">0x${H2(c.code)}</td>
              <td class="truncate py-1 text-slate-200">${esc(c.name)}</td>
              <td class="w-24 py-1">${c.role && ROLE_LABEL[c.role] ? `<span class="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent-strong">${ROLE_LABEL[c.role]}</span>` : ''}</td>
              <td class="w-16 py-1 text-2xs tabular-nums text-slate-500">p. ${c.pages[0]}</td>
              <td class="w-28 py-1 pr-2 text-right"><button type="button" data-add-cmd="${c.code}" ${custom() ? '' : 'disabled title="Aplica primero la selección"'} class="btn btn-ghost !h-6 !px-1.5 text-2xs">${icon('plus', 'h-3 w-3')}Al arranque</button></td>
            </tr>`).join('') || '<tr><td class="px-3 py-3 text-slate-500">Ningún comando coincide.</td></tr>'}
          </tbody></table>
        </div>
      </section>
    </div>`;
    pane.querySelector('[data-ref=sheet-reset]').addEventListener('click', () => {
      state.sheet = { status: 'idle', progress: '', result: null, apply: new Set(), filter: '', error: '' };
      renderPane();
    });
    pane.querySelectorAll('[data-apply]').forEach((el) => el.addEventListener('change', () => {
      if (el.checked) state.sheet.apply.add(el.dataset.apply);
      else state.sheet.apply.delete(el.dataset.apply);
    }));
    pane.querySelector('[data-ref=sheet-apply]').addEventListener('click', applySheet);
    pane.querySelector('[data-ref=sheet-filter]').addEventListener('input', (e) => {
      state.sheet.filter = e.target.value;
      const pos = e.target.selectionStart;
      datasheet(pane);
      const input = pane.querySelector('[data-ref=sheet-filter]');
      input.focus();
      input.setSelectionRange(pos, pos);
    });
    pane.querySelectorAll('[data-add-cmd]').forEach((b) => b.addEventListener('click', () => {
      const c = r.commands.find((x) => x.code === Number(b.dataset.addCmd));
      const p = profile();
      p.init = `${(p.init ?? '').replace(/\s+$/, '')}${p.init ? '\n' : ''}${stepLine(c.code, [], c.name)}`;
      b.innerHTML = `${icon('check', 'h-3 w-3')}Añadido`;
      b.disabled = true;
      refreshSide();
    }));
  }

  async function readSheet(file) {
    if (!file) return;
    state.sheet = { status: 'reading', progress: 'Abriendo el archivo', result: null, apply: new Set(), filter: '', error: '' };
    renderPane();
    try {
      const { readDatasheet, analyzeDatasheet } = await import('../displays/datasheet.js');
      const doc = await readDatasheet(file, (n, total) => {
        state.sheet.progress = `Página ${n} de ${total}`;
        const bar = $('[data-ref=sheet-bar]');
        if (bar) bar.style.width = `${Math.round((n / total) * 100)}%`;
        const label = $('[data-ref=sheet-progress]');
        if (label) label.textContent = state.sheet.progress;
      });
      const lines = doc.pages.reduce((n, p) => n + p.length, 0);
      if (lines < 5) throw new Error('El documento no tiene texto legible. Si es un PDF escaneado, busca la versión digital de la hoja de datos.');
      const result = analyzeDatasheet(doc);
      state.sheet.status = 'done';
      state.sheet.result = result;
      state.sheet.apply = new Set(result.fields.filter((f) => f.found && f.key !== 'family').map((f) => f.key));
    } catch (error) {
      state.sheet.status = 'error';
      state.sheet.error = `No se pudo leer "${file.name}": ${error.message}`;
    }
    if (state.tab === 'datasheet') renderPane();
  }

  function applySheet() {
    const r = state.sheet.result;
    const pick = state.sheet.apply;
    if (!pick.size) return;
    if (!custom()) {
      state.spec.controller = 'custom';
      state.spec.profile = makeProfile(TEMPLATES.blank.profile);
      delete state.spec.cols;
      delete state.spec.rows;
    }
    const p = profile();
    const s = r.profile;
    const copy = {
      name: () => { p.name = s.name; if (!state.spec.label.trim()) state.spec.label = s.name.slice(0, 24); },
      resolution: () => Object.assign(state.spec, { width: r.spec.width, height: r.spec.height }),
      kind: () => { p.kind = s.kind; },
      format: () => { p.pixel = { ...s.pixel }; },
      buses: () => { p.buses = [...s.buses]; },
      dc: () => { p.dc = s.dc; p.i2cCtrl = { ...s.i2cCtrl }; },
      i2cAddr: () => { p.i2cAddr = s.i2cAddr; },
      pins: () => { p.reset = s.reset; p.busy = s.busy; },
      window: () => { p.window = { ...s.window }; },
      write: () => { p.write = s.write; },
      update: () => { p.update = s.update; },
      brightness: () => { p.brightness = s.brightness ? { ...s.brightness } : null; },
      rotate: () => { p.rotate = s.rotate ? { ...s.rotate, values: [...s.rotate.values] } : null; },
      init: () => { p.init = s.init; },
    };
    pick.forEach((key) => copy[key]?.());
    const techByKind = { epaper: 'epaper', gray: 'oledGray', mono: 'oled', lcd: 'lcdMono', color: 'tft' };
    if (techInfo(state.spec.tech).kind !== p.kind) state.spec.tech = techByKind[p.kind] ?? 'other';
    state.spec.driver = OTHER_DRIVER;
    p.source = { ...r.source, date: new Date().toISOString().slice(0, 10) };
    state.flash = { kind: 'info', text: `Aplicado desde ${r.source.file}. Revisa Protocolo y Secuencias: los parámetros de cada comando casi nunca vienen en texto plano.` };
    state.tab = 'protocol';
    renderPane();
  }

  // ------------------------------------------------------------- Diseño

  let picker = null;
  function design(pane) {
    pane.innerHTML = `<div class="space-y-3">
      <p class="text-xs text-slate-400">Opcional: un diseño de Figma o una imagen que se cargará como primer fotograma de esta pantalla.</p>
      <div data-ref="picker"></div></div>`;
    picker = designPicker(pane.querySelector('[data-ref=picker]'), {
      getTarget: () => ({ W: state.spec.width, H: state.spec.height, mono: currentType() === 'mono', config: previewConfig() }),
      state: state.design,
      notify,
      onChange: refreshSide,
    });
  }

  const currentType = () => (custom() ? editorType(profile()) : controller().type);
  const previewConfig = () => {
    if (custom()) {
      const k = kindInfo(profile().kind);
      return { profile: profile(), previewOn: k.on, previewOff: k.off, type: currentType() };
    }
    return { format: currentType() === 'mono' ? 2 : 1, previewOn: controller().previewOn ?? '#ffffff', previewOff: controller().previewOff ?? '#000000', type: currentType() };
  };

  // ------------------------------------------------------------- lateral

  function silhouette() {
    const s = state.spec;
    const w = character() ? s.cols * 6 : s.width || 1;
    const h = character() ? s.rows * 9 : s.height || 1;
    const scale = Math.min(170 / w, 120 / h);
    const color = custom() ? kindInfo(profile().kind) : null;
    const fill = character() ? '#5f7f2a' : color ? (profile().kind === 'epaper' ? color.on : color.off) : controller().previewOff ?? '#121417';
    return `<svg viewBox="0 0 ${w} ${h}" width="${w * scale}" height="${h * scale}" aria-hidden="true">
      ${s.round ? `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}" stroke="#7aa7ff" stroke-width="${w * 0.015}"/>`
        : `<rect width="${w}" height="${h}" rx="${Math.min(w, h) * 0.03}" fill="${fill}" stroke="#7aa7ff" stroke-width="${Math.max(w, h) * 0.012}"/>`}</svg>`;
  }

  function refreshSide() {
    const s = state.spec;
    const key = editingKey ?? slugKey(s.label);
    const check = validateSpec({ ...s, key }, editingKey);
    const errors = [...check.errors];
    const warnings = [...check.warnings];
    const driver = driverInfo(s.tech, s.driver);
    let rows = [
      ['Tipo', techInfo(s.tech).label],
      ['Driver', driver?.label || (custom() && profile().name) || 'otro'],
    ];
    if (s.diagonal > 0 && !character()) rows.push(['Densidad', `${Math.round(Math.hypot(s.width, s.height) / s.diagonal)} ppp (${s.diagonal}")`]);
    if (s.touch) rows.push(['Táctil', touchLabel(s.touch)]);
    if (custom()) {
      const p = profile();
      const pc = checkProfile(p);
      errors.push(...pc.errors);
      warnings.push(...pc.warnings);
      const fmt = formatInfo(p.pixel.format);
      rows.push(
        ['Interfaz', p.buses.map((b) => BUS_LABELS[b]).join(', ') || 'ninguna'],
        ['Formato', fmt.label],
        ['Frame nativo', `${nativeBytes(p.pixel.format, s.width || 0, s.height || 0).toLocaleString('es')} B`],
        ['Arranque', `${pc.init.steps.filter((x) => x.cmd != null).length} comandos`],
        ['Refresco', pc.update.steps.length ? `${pc.update.steps.filter((x) => x.cmd != null).length} comandos` : 'no'],
      );
      if (p.source) rows.push(['Hoja de datos', p.source.file]);
    } else {
      rows.push(['Interfaz', controller().buses.map((b) => BUS_LABELS[b]).join(', ')]);
    }
    $('[data-ref=side]').innerHTML = `
      <div class="bench grid h-40 place-items-center rounded-lg border border-ink-600 p-3">${silhouette()}</div>
      <p class="text-center text-2xs tabular-nums text-slate-500">${character() ? `${s.cols} x ${s.rows} caracteres` : `${s.width} x ${s.height} px`}</p>
      ${state.design.source ? `<p class="flex items-center gap-1.5 text-2xs text-slate-400">${icon('layers', 'h-3 w-3')}Diseño inicial: ${esc(state.design.name)}</p>` : ''}
      <dl class="space-y-1 text-2xs">${rows.map(([k, v]) => `<div class="flex justify-between gap-3"><dt class="text-slate-500">${k}</dt><dd class="truncate text-right text-slate-300" title="${esc(v)}">${esc(v)}</dd></div>`).join('')}</dl>
      <ul class="space-y-1.5 text-2xs leading-snug" aria-live="polite">
        ${errors.map((m) => `<li class="flex gap-1.5 text-red-300">${icon('alert', 'mt-px h-3 w-3')}<span>${esc(m)}</span></li>`).join('')}
        ${warnings.map((m) => `<li class="flex gap-1.5 text-amber-300/90">${icon('info', 'mt-px h-3 w-3')}<span>${esc(m)}</span></li>`).join('')}
      </ul>`;
    save.disabled = errors.length > 0;
    seqStatus();
  }

  // ------------------------------------------------------------- enlaces

  modal.body.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab || tab.disabled) return;
    state.tab = tab.dataset.tab;
    state.flash = null;
    renderPane();
  });
  const onBind = (e) => {
    const el = e.target.closest('[data-bind]');
    if (!el) return;
    const type = el.dataset.type;
    let value = el.type === 'checkbox' ? el.checked : el.value;
    if (type === 'int') value = value === '' ? null : Number(value);
    else if (type === 'float') value = value === '' ? null : Number(value);
    else if (type === 'bool' && el.type !== 'checkbox') value = value === 'true';
    else if (type === 'nullable') value = value || null;
    else if (type === 'hex') {
      value = parseHex(value);
      if (value === undefined) {
        if (e.type === 'change') el.classList.add('!border-red-400/60');
        return;
      }
      el.classList.remove('!border-red-400/60');
      // brillo y rotación: el objeto completo desaparece cuando se borra su comando
      if (/\.(brightness|rotate)\.cmd$/.test(el.dataset.bind)) {
        const base = el.dataset.bind.replace(/\.cmd$/, '');
        const obj = getPath(state, base);
        if (value == null) return setPath(state, base, null), refreshSide();
        if (!obj) setPath(state, base, base.endsWith('brightness') ? { cmd: value, max: 255 } : { cmd: value, values: [0x00, 0x60, 0xc0, 0xa0] });
      }
    }
    if (el.dataset.bind === 'spec.profile.brightness.max' && !profile().brightness) return;
    setPath(state, el.dataset.bind, value);
    if (el.dataset.bind === 'spec.label') state.autoLabel = false;
    if (e.type === 'change' && el.hasAttribute('data-rerender')) renderPane();
    else refreshSide();
  };
  modal.body.addEventListener('input', onBind);
  modal.body.addEventListener('change', onBind);
  modal.dialog.addEventListener('paste', (e) => {
    if (state.tab !== 'design' || !picker) return;
    import('./design-import.js').then(({ fileFromClipboard }) => {
      const file = fileFromClipboard(e);
      if (file) picker.load(file);
    });
  });

  save.addEventListener('click', () => {
    const key = editingKey ?? slugKey(state.spec.label);
    const spec = { ...state.spec, key, label: state.spec.label.trim(), custom: true };
    if (custom()) spec.profile = { ...profile(), name: profile().name || spec.label };
    else delete spec.profile;
    const check = validateSpec(spec, editingKey);
    if (check.errors.length) return refreshSide();
    const designImage = !character() && state.design.source ? picker?.image() ?? null : null;
    registerDisplay(spec);
    saveCustomDisplays();
    modal.close();
    onSaved(key, { design: designImage });
  });

  if (state.autoLabel) state.spec.label = suggestLabel();
  renderPane();
  modal.open();
  modal.body.querySelector('#d-name')?.focus();
}
