import { icon } from './svg-icons.js';

const BADGES = {
  unsupported: ['Sin Web Serial', 'bg-red-400', 'Este navegador no soporta Web Serial: los envíos se simulan'],
  disconnected: ['Simulación', 'bg-amber-400', 'Sin ESP32 conectado: los envíos se simulan localmente'],
  connecting: ['Conectando', 'bg-accent animate-pulse', 'Abriendo el puerto serie'],
  connected: ['Conectado', 'bg-emerald-400', 'Conectado a 921600 baud'],
};

const NOTICE_STYLES = {
  error: ['text-red-300', 'alert'],
  warn: ['text-amber-300', 'alert'],
  info: ['text-accent', 'info'],
};

const LOG_STYLES = {
  tx: ['TX', 'text-accent'],
  rx: ['RX', 'text-emerald-300'],
  err: ['ERR', 'text-red-300'],
  sim: ['SIM', 'text-amber-300'],
  sys: ['SYS', 'text-slate-400'],
};

const MAX_LOG_ENTRIES = 300;

/** Insignia de estado, avisos en línea (sin alert()), consola serial y barra de progreso. */
export class StatusView {
  #hideTimer = 0;

  constructor({ badge, notices, log, progress }) {
    this.badge = badge;
    this.notices = notices;
    this.logEl = log;
    this.progress = progress;
  }

  setConnection(state) {
    const [text, dot, title] = BADGES[state];
    this.badge.title = title;
    this.badge.innerHTML = `<span class="h-1.5 w-1.5 rounded-full ${dot}"></span><span>${text}</span>`;
  }

  /** Aviso flotante. Los errores quedan hasta cerrarlos; avisos e información se retiran solos. `key` evita duplicados. */
  notice(kind, message, key = message) {
    this.dismissNotice(key);
    const [color, ico] = NOTICE_STYLES[kind];
    const el = document.createElement('div');
    el.dataset.key = key;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.className = 'toast-in pointer-events-auto flex items-start gap-2.5 rounded-lg border border-ink-600 bg-ink-800 py-2 pl-3 pr-1.5 text-xs leading-relaxed text-slate-200 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]';
    el.innerHTML = `<span class="${color} mt-0.5">${icon(ico, 'h-3.5 w-3.5')}</span><p class="min-w-0 flex-1"></p>
      <button type="button" class="btn btn-ghost btn-icon !h-6 !w-6" aria-label="Cerrar aviso">${icon('close', 'h-3.5 w-3.5')}</button>`;
    el.querySelector('p').textContent = message;
    el.querySelector('button').addEventListener('click', () => el.remove());
    if (kind !== 'error') setTimeout(() => el.remove(), 9000);
    this.notices.append(el);
  }

  dismissNotice(key) {
    this.notices.querySelectorAll('[data-key]').forEach((el) => el.dataset.key === key && el.remove());
  }

  log(kind, text) {
    const [label, color] = LOG_STYLES[kind];
    const row = document.createElement('div');
    row.className = 'flex gap-3 leading-5';
    const time = new Date().toLocaleTimeString('es', { hour12: false });
    row.innerHTML = `<span class="text-slate-600">${time}</span><span class="w-7 shrink-0 font-medium ${color}">${label}</span><span class="min-w-0 flex-1 break-all text-slate-300"></span>`;
    row.lastElementChild.textContent = text;

    const pinned = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 8;
    this.logEl.append(row);
    while (this.logEl.childElementCount > MAX_LOG_ENTRIES) this.logEl.firstElementChild.remove();
    if (pinned) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  clearLog() {
    this.logEl.replaceChildren();
  }

  /** `sent`/`total` en bytes. Con total = 0 oculta la barra. */
  setProgress(sent, total) {
    const { root, bar, label } = this.progress;
    clearTimeout(this.#hideTimer);
    root.hidden = total === 0;
    if (total === 0) return;
    // Al completar un envío, la barra se retira sola para devolver el espacio al lienzo.
    if (sent >= total) this.#hideTimer = setTimeout(() => (root.hidden = true), 1500);
    const percent = Math.round((sent / total) * 100);
    bar.style.width = `${percent}%`;
    root.setAttribute('aria-valuenow', String(percent));
    label.textContent = `${sent.toLocaleString('es')} / ${total.toLocaleString('es')} bytes (${percent}%)`;
  }
}
