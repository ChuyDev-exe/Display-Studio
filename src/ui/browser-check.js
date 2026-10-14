import { gifSupported } from '../displays/image-import.js';
import { SerialManager } from '../serial/serial-manager.js';
import { createModal, esc, modalButton } from './modal.js';
import { icon } from './svg-icons.js';

const DISMISS_KEY = 'esp32-display-studio.browserNotice';

/** Nombre del navegador y si es móvil (para el mensaje; las capacidades se comprueban aparte). */
export function detectBrowser() {
  const ua = navigator.userAgent;
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) ?? [];
  const mobile = navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
  let name = 'Navegador desconocido';
  if (brands.includes('Microsoft Edge') || /Edg\//.test(ua)) name = 'Microsoft Edge';
  else if (brands.includes('Opera') || /OPR\//.test(ua)) name = 'Opera';
  else if (/Firefox\//.test(ua)) name = 'Firefox';
  else if (brands.includes('Google Chrome') || /Chrome\//.test(ua)) name = 'Google Chrome';
  else if (/Safari\//.test(ua)) name = 'Safari';
  return { name, mobile };
}

/** Qué funciona aquí: conexión USB, contexto seguro y GIF animados. */
export function capabilities() {
  return {
    serial: SerialManager.supported,
    secure: window.isSecureContext,
    gif: gifSupported(),
  };
}

const remembered = () => { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } };
const remember = (value) => { try { value ? localStorage.setItem(DISMISS_KEY, '1') : localStorage.removeItem(DISMISS_KEY); } catch { /* sin almacenamiento */ } };

/**
 * Aviso de compatibilidad. Al cargar (`auto`) aparece siempre si falta la conexión USB, y si todo
 * funciona solo hasta que el usuario marca "No volver a mostrar". Desde el botón de la cabecera, siempre.
 */
export function openBrowserCheck({ auto = false } = {}) {
  const caps = capabilities();
  if (auto && caps.serial && remembered()) return;
  const { name, mobile } = detectBrowser();
  const ok = caps.serial;

  const modal = createModal({ title: 'Navegadores compatibles', size: 'max-w-xl' });
  const row = (state, title, detail) => {
    const [ic, tone] = { yes: ['check', 'text-emerald-300'], no: ['close', 'text-red-300'], partial: ['alert', 'text-amber-300'] }[state];
    return `<li class="flex gap-2.5 py-2">
      <span class="mt-px ${tone}">${icon(ic, 'h-3.5 w-3.5')}</span>
      <div class="min-w-0"><p class="text-xs text-slate-100">${title}</p><p class="mt-0.5 text-2xs leading-relaxed text-slate-400">${detail}</p></div></li>`;
  };
  const browserRow = (label, state, note) => `<tr class="border-t border-ink-600">
    <td class="py-1.5 pr-3 text-slate-200">${label}</td>
    <td class="py-1.5 pr-3">${state ? `<span class="text-emerald-300">Completa</span>` : `<span class="text-amber-300">Solo simulación</span>`}</td>
    <td class="py-1.5 text-slate-500">${note}</td></tr>`;

  modal.body.innerHTML = `
    <div class="space-y-4">
      <div class="flex items-start gap-3 rounded-lg border px-3 py-2.5 ${ok ? 'border-emerald-400/30 bg-emerald-400/[.06]' : 'border-amber-400/30 bg-amber-400/[.06]'}">
        <span class="mt-0.5 ${ok ? 'text-emerald-300' : 'text-amber-300'}">${icon(ok ? 'check' : 'alert', 'h-4 w-4')}</span>
        <div class="min-w-0 text-xs leading-relaxed">
          <p class="font-medium text-white">${ok ? `${esc(name)} es compatible` : `${esc(name)}${mobile ? ' (móvil)' : ''}: modo simulación`}</p>
          <p class="mt-0.5 text-slate-300">${ok
            ? 'Puedes diseñar y enviar a tu ESP32 por USB.'
            : 'Puedes diseñar, importar y exportar código, pero no conectar el ESP32 por USB: los envíos se simulan en la consola.'}</p>
        </div>
      </div>

      <section class="space-y-1">
        <h3 class="text-xs font-semibold text-white">En este navegador</h3>
        <ul class="divide-y divide-ink-700">
          ${row(caps.serial ? 'yes' : 'no', 'Conexión USB con el ESP32 (Web Serial)', caps.serial
            ? 'Disponible. Al pulsar Conectar, el navegador te pedirá elegir el puerto.'
            : caps.secure ? 'Este navegador no implementa Web Serial.' : 'Necesita un contexto seguro: abre la página desde https:// o desde localhost.')}
          ${row(caps.secure ? 'yes' : 'no', 'Página servida de forma segura', caps.secure ? 'HTTPS o localhost.' : `Se abrió desde ${esc(location.protocol)}//${esc(location.host)}; Web Serial no funciona así.`)}
          ${row('yes', 'Editor, importar diseños y Figma, exportar código C', 'Funciona en cualquier navegador actual.')}
          ${row(caps.gif ? 'yes' : 'partial', 'Importar GIF animados', caps.gif ? 'Se leen todos los fotogramas.' : 'Solo se importa el primer fotograma (falta ImageDecoder).')}
        </ul>
      </section>

      <section class="space-y-2">
        <h3 class="text-xs font-semibold text-white">Dónde funciona todo</h3>
        <div class="overflow-x-auto rounded-lg border border-ink-600 bg-ink-950 px-3">
          <table class="w-full text-left text-xs">
            <thead><tr class="text-2xs text-slate-500"><th class="py-1.5 pr-3 font-medium">Navegador</th><th class="py-1.5 pr-3 font-medium">Soporte</th><th class="py-1.5 font-medium">Notas</th></tr></thead>
            <tbody>
              ${browserRow('Google Chrome', true, 'Escritorio, versión 89 o posterior')}
              ${browserRow('Microsoft Edge', true, 'Escritorio, versión 89 o posterior')}
              ${browserRow('Opera', true, 'Escritorio, versión 75 o posterior')}
              ${browserRow('Firefox', false, 'No implementa Web Serial')}
              ${browserRow('Safari', false, 'No implementa Web Serial')}
              ${browserRow('Móviles y tabletas', false, 'iOS y Android no permiten la conexión USB')}
            </tbody>
          </table>
        </div>
      </section>
    </div>`;

  const footer = [];
  if (ok) {
    const label = document.createElement('label');
    label.className = 'mr-auto flex items-center gap-2 text-xs text-slate-400';
    label.innerHTML = `<input type="checkbox" ${remembered() ? 'checked' : ''} />No volver a mostrar al entrar`;
    label.querySelector('input').addEventListener('change', (e) => remember(e.target.checked));
    footer.push(label);
  }
  const close = modalButton(ok ? 'Empezar' : 'Continuar en simulación', 'btn-accent', modal.close);
  footer.push(close);
  modal.footer.append(...footer);
  modal.open();
  close.focus();
}
