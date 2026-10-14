import { testToken } from '../figma/figma-api.js';
import { figmaSettings } from '../figma/figma-settings.js';
import { createModal, esc, modalButton } from './modal.js';
import { icon } from './svg-icons.js';

const TOKEN_HELP = 'https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens';

const TABS = [
  ['connect', 'Conexión', 'plug'],
  ['guide', 'Preparar el diseño', 'layers'],
];

const step = (n, html) => `
  <li class="flex gap-3">
    <span class="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-ink-500 text-2xs tabular-nums text-slate-300">${n}</span>
    <p class="pt-px text-xs leading-relaxed text-slate-300">${html}</p>
  </li>`;
const b = (text) => `<span class="font-medium text-slate-100">${text}</span>`;

/**
 * Modal "Configurar Figma": token de acceso con instrucciones paso a paso, prueba de conexión
 * y guía para diseñar frames que encajen en las pantallas.
 *
 * @param opts.displays    configs de las pantallas gráficas (para la tabla de tamaños)
 * @param opts.tab         pestaña inicial: 'connect' | 'guide'
 * @param opts.onSaved()   el token cambió (guardado o borrado)
 */
export function openFigmaSettings({ displays, tab = 'connect', onSaved = () => {} }) {
  const state = {
    tab, token: figmaSettings.token, remember: figmaSettings.token ? figmaSettings.remembered : true,
    url: figmaSettings.url, reveal: false, busy: false, error: '', ok: '',
  };
  const modal = createModal({ title: 'Configurar Figma', size: 'max-w-3xl', bodyClass: 'p-0' });

  const render = () => {
    modal.body.innerHTML = `
      <div role="tablist" aria-label="Secciones" class="flex gap-1 border-b border-ink-600 px-3">
        ${TABS.map(([id, label, ic]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${state.tab === id}" class="tab">${icon(ic, 'h-3.5 w-3.5')}${label}</button>`).join('')}
      </div>
      <div class="p-4">${state.tab === 'connect' ? connectHtml() : guideHtml()}</div>`;
    modal.footer.replaceChildren(...footer());
    bind();
  };

  // ---------------------------------------------------------------- conexión

  const statusHtml = () => {
    const saved = figmaSettings.token;
    const user = figmaSettings.user;
    const [tone, ic, text] = saved
      ? ['border-emerald-400/30 bg-emerald-400/[.06] text-emerald-200', 'check',
        `Figma configurado${user ? ` como ${b(esc(user))}` : ''}. ${figmaSettings.remembered ? 'El token está guardado en este navegador.' : 'El token se olvidará al recargar la página.'}`]
      : ['border-ink-600 bg-ink-950 text-slate-300', 'info', 'Aún no hay token. Sigue los pasos para crear uno; solo hace falta una vez.'];
    return `<p class="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${tone}">${icon(ic, 'mt-px h-3.5 w-3.5')}<span>${text}</span></p>`;
  };

  const connectHtml = () => `
    <div class="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section aria-labelledby="fs-steps" class="space-y-3">
        <h3 id="fs-steps" class="text-xs font-semibold text-white">Cómo crear el token</h3>
        <ol class="space-y-2.5">
          ${step(1, `Abre ${b('figma.com')} con tu cuenta. Haz clic en tu nombre o avatar (arriba a la izquierda) y entra en ${b('Settings')}.`)}
          ${step(2, `En la pestaña ${b('Security')}, baja hasta ${b('Personal access tokens')} y pulsa ${b('Generate new token')}.`)}
          ${step(3, `Ponle un nombre que reconozcas, por ejemplo ${b('ESP32 Display Studio')}, y elige cuándo caduca.`)}
          ${step(4, `En los permisos (scopes) marca ${b('File content: Read only')}. Opcional: ${b('Current user: Read')}, para que la prueba muestre tu cuenta.`)}
          ${step(5, `Pulsa ${b('Generate token')} y cópialo: empieza por ${b('figd_')} y Figma solo lo muestra una vez.`)}
          ${step(6, `Pégalo aquí y pulsa ${b('Probar y guardar')}.`)}
        </ol>
        <a href="${TOKEN_HELP}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-2xs text-accent hover:text-accent-strong">Ayuda de Figma sobre tokens${icon('arrow-right', 'h-3 w-3')}</a>
      </section>

      <form data-ref="form" class="space-y-4" autocomplete="off">
        ${statusHtml()}
        <div><label class="field-label" for="fs-token">Token de acceso personal</label>
          <div class="flex gap-1.5">
            <input id="fs-token" data-ref="token" class="input font-mono" type="${state.reveal ? 'text' : 'password'}" required placeholder="figd_…" value="${esc(state.token)}" spellcheck="false" />
            <button type="button" data-ref="reveal" class="btn btn-icon" aria-pressed="${state.reveal}" aria-label="${state.reveal ? 'Ocultar' : 'Mostrar'} token" title="${state.reveal ? 'Ocultar' : 'Mostrar'}">${icon(state.reveal ? 'eye-off' : 'eye', 'h-3.5 w-3.5')}</button>
          </div></div>
        <div><label class="field-label" for="fs-url">Archivo para probar (opcional)</label>
          <input id="fs-url" data-ref="url" class="input" type="url" placeholder="https://www.figma.com/design/…" value="${esc(state.url)}" spellcheck="false" />
          <p class="mt-1.5 text-2xs leading-relaxed text-slate-500">Si el token solo tiene "File content", la prueba lee este archivo. También queda como enlace por defecto al importar.</p></div>
        <label class="flex items-center gap-2 text-xs text-slate-300"><input data-ref="remember" type="checkbox" ${state.remember ? 'checked' : ''} />Recordar el token en este navegador</label>
        <p class="text-2xs leading-relaxed text-slate-500">El token solo se envía a api.figma.com y da acceso de lectura a tus archivos. No lo compartas; si lo pierdes, revócalo en Figma y crea otro.</p>
        ${state.error ? `<p role="alert" class="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-400/[.06] px-3 py-2 text-xs text-red-200">${icon('alert', 'mt-px h-3.5 w-3.5')}${esc(state.error)}</p>` : ''}
        ${state.ok ? `<p role="status" class="flex items-start gap-2 rounded-lg border border-emerald-400/30 bg-emerald-400/[.06] px-3 py-2 text-xs text-emerald-200">${icon('check', 'mt-px h-3.5 w-3.5')}${esc(state.ok)}</p>` : ''}
      </form>
    </div>`;

  async function testAndSave() {
    const token = state.token.trim();
    if (!token) {
      Object.assign(state, { error: 'Pega primero el token.', ok: '' });
      return render();
    }
    Object.assign(state, { busy: true, error: '', ok: '' });
    render();
    try {
      const { handle, file } = await testToken(token, state.url);
      figmaSettings.save(token, { remember: state.remember, user: handle });
      if (state.url.trim()) figmaSettings.url = state.url;
      state.ok = handle ? `Conectado como ${handle}. Ya puedes importar.` : `Token válido: se leyó "${file}". Ya puedes importar.`;
      onSaved();
    } catch (error) {
      state.error = error.message;
    }
    state.busy = false;
    render();
  }

  // ------------------------------------------------------------------- guía

  const sizeRows = () => displays.map((d) => {
    const rotated = d.width !== d.height ? `${d.height} x ${d.width}` : '';
    const color = d.type === 'mono' ? (d.profile?.kind === 'epaper' ? 'Tinta / papel' : '1 bit') : 'Color RGB565';
    return `<tr class="border-t border-ink-600">
      <td class="py-1.5 pr-3 text-slate-200">${esc(d.label)}${d.round ? ' <span class="text-slate-500">· redonda</span>' : ''}</td>
      <td class="py-1.5 pr-3 tabular-nums text-slate-100">${d.width} x ${d.height}</td>
      <td class="py-1.5 pr-3 tabular-nums text-slate-400">${rotated || '—'}</td>
      <td class="py-1.5 text-slate-400">${color}</td></tr>`;
  }).join('');

  const guideHtml = () => `
    <div class="space-y-5">
      <section aria-labelledby="fs-sizes" class="space-y-2">
        <h3 id="fs-sizes" class="text-xs font-semibold text-white">Tamaños de frame por pantalla</h3>
        <p class="text-xs leading-relaxed text-slate-400">Un frame se carga solo en las pantallas cuyo tamaño coincide. También valen los múltiplos exactos (480 x 480 para 240 x 240) y la orientación girada.</p>
        <div class="overflow-x-auto rounded-lg border border-ink-600 bg-ink-950 px-3">
          <table class="w-full text-left text-xs">
            <thead><tr class="text-2xs text-slate-500"><th class="py-1.5 pr-3 font-medium">Pantalla</th><th class="py-1.5 pr-3 font-medium">Frame</th><th class="py-1.5 pr-3 font-medium">Girada 90°</th><th class="py-1.5 font-medium">Color</th></tr></thead>
            <tbody>${sizeRows()}</tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="fs-how" class="space-y-3">
        <h3 id="fs-how" class="text-xs font-semibold text-white">Cómo preparar el archivo</h3>
        <ol class="space-y-2.5">
          ${step(1, `Crea un frame con la herramienta ${b('Frame (F)')} y escribe el ancho y el alto exactos en el panel derecho. Así cada píxel del diseño es un píxel del panel.`)}
          ${step(2, `Deja los frames sueltos en la página o dentro de una ${b('sección')}. Los frames anidados dentro de otro frame no se importan por separado.`)}
          ${step(3, `Varios frames del mismo tamaño forman una animación: se ordenan como se leen en el lienzo, de arriba abajo y de izquierda a derecha.`)}
          ${step(4, `Para pantallas de 1 bit usa blanco y negro puros: blanco enciende el píxel y negro lo apaga (en e-paper, negro es tinta). Los grises se reducen con tramado.`)}
          ${step(5, `En pantallas pequeñas usa fuentes pixel (por ejemplo ${b('Press Start 2P')} o ${b('Silkscreen')}) a su tamaño nativo: el texto suavizado se ve borroso.`)}
          ${step(6, `En la GC9A01 redonda solo se ve el círculo inscrito: deja las esquinas vacías.`)}
          ${step(7, `Copia el enlace con ${b('Share, Copy link')}. Si copias el enlace con un frame o una página seleccionada, solo se importa eso.`)}
        </ol>
      </section>
    </div>`;

  // ------------------------------------------------------------------- común

  function footer() {
    if (state.tab === 'guide') return [modalButton('Cerrar', 'btn-primary', modal.close)];
    const buttons = [];
    if (figmaSettings.token) {
      buttons.push(modalButton('Borrar token', 'btn-danger mr-auto', () => {
        figmaSettings.clear();
        Object.assign(state, { token: '', ok: 'Token borrado de este navegador.', error: '' });
        onSaved();
        render();
      }));
    }
    const go = modalButton('', 'btn-accent', () => modal.body.querySelector('[data-ref=form]').requestSubmit());
    go.innerHTML = `${icon('check', 'h-3.5 w-3.5')}${state.busy ? 'Probando…' : 'Probar y guardar'}`;
    go.disabled = state.busy;
    buttons.push(modalButton('Cerrar', 'btn-ghost', modal.close), go);
    return buttons;
  }

  function bind() {
    const $ = (s) => modal.body.querySelector(s);
    modal.body.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => { state.tab = t.dataset.tab; render(); }));
    const form = $('[data-ref=form]');
    if (!form) return;
    form.addEventListener('submit', (e) => { e.preventDefault(); if (!state.busy) testAndSave(); });
    $('[data-ref=token]').addEventListener('input', (e) => (state.token = e.target.value));
    $('[data-ref=url]').addEventListener('input', (e) => (state.url = e.target.value));
    $('[data-ref=remember]').addEventListener('change', (e) => (state.remember = e.target.checked));
    $('[data-ref=reveal]').addEventListener('click', () => { state.reveal = !state.reveal; render(); $('[data-ref=token]').focus(); });
    if (!state.token && !state.busy) $('[data-ref=token]').focus();
  }

  render();
  modal.open();
  return modal;
}
