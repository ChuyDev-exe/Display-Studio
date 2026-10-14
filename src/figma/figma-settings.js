/*
  Configuración de Figma: el token personal y el último enlace usado. El token se guarda en
  localStorage solo si el usuario lo pide; si no, vive en memoria hasta recargar la página.
*/

const KEYS = { token: 'figma:token', url: 'figma:url', user: 'figma:user' };
let sessionToken = '';
let sessionUser = '';

const read = (key) => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const write = (key, value) => { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* sin almacenamiento */ } };

export const figmaSettings = {
  get token() {
    return sessionToken || read(KEYS.token);
  },
  get remembered() {
    return Boolean(read(KEYS.token));
  },
  /** Nombre de la cuenta con la que se probó el token (solo informativo). */
  get user() {
    return sessionUser || read(KEYS.user);
  },
  get url() {
    return read(KEYS.url);
  },
  set url(value) {
    write(KEYS.url, value.trim());
  },
  save(token, { remember, user = '' }) {
    sessionToken = token.trim();
    sessionUser = user;
    write(KEYS.token, remember ? sessionToken : '');
    write(KEYS.user, remember ? user : '');
  },
  clear() {
    sessionToken = sessionUser = '';
    write(KEYS.token, '');
    write(KEYS.user, '');
  },
};
