import { DISPLAYS, DISPLAY_ORDER, registerDisplay } from './display-configs.js';

const STORAGE_KEY = 'esp32-display-studio.customDisplays';

/** Registra las pantallas propias guardadas en el navegador. */
export function loadCustomDisplays() {
  try {
    const specs = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    specs.forEach((spec) => registerDisplay({ ...spec, custom: true }));
  } catch {
    /* sin almacenamiento o datos corruptos: se parte de las integradas */
  }
}

export function saveCustomDisplays() {
  try {
    const specs = DISPLAY_ORDER.map((key) => DISPLAYS[key]).filter((d) => d.custom).map((d) => d.spec);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(specs));
  } catch {
    /* sin almacenamiento: la pantalla vive solo en esta sesión */
  }
}
