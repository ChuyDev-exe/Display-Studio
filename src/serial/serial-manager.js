import { chunkPayload, encodeJsonCommand } from './protocol.js';

export const BAUD_RATE = 921600;

/**
 * Envuelve Web Serial. Eventos (CustomEvent, datos en `detail`):
 *  - state: { state: 'connecting' | 'connected' | 'disconnected', reason? }
 *  - line:  { text }        línea recibida del ESP32
 *  - error: { error }       error no fatal (lectura, escritura)
 */
export class SerialManager extends EventTarget {
  #port = null;
  #reader = null;
  #writer = null;
  #readTask = null;
  #closing = false;
  #queue = Promise.resolve();

  static get supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  get connected() {
    return this.#writer !== null;
  }

  constructor() {
    super();
    if (SerialManager.supported) {
      // Se dispara cuando el usuario desenchufa el cable.
      navigator.serial.addEventListener('disconnect', (event) => {
        if (event.target === this.#port) this.#teardown('Dispositivo desconectado');
      });
    }
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Devuelve false si el usuario cierra el selector de puertos sin elegir. */
  async connect() {
    if (!SerialManager.supported) throw new Error('Este navegador no soporta Web Serial.');
    if (this.#port) return true;

    this.#emit('state', { state: 'connecting' });
    let port;
    try {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: BAUD_RATE });
    } catch (error) {
      this.#emit('state', { state: 'disconnected' });
      if (error.name === 'NotFoundError') return false; // selector cancelado
      throw error;
    }

    this.#port = port;
    this.#closing = false;
    this.#writer = port.writable.getWriter();
    this.#readTask = this.#readLoop(port);
    this.#emit('state', { state: 'connected' });
    return true;
  }

  async disconnect() {
    if (!this.#port) return;
    await this.#teardown('Desconectado por el usuario');
  }

  /** Lee bytes y emite una `line` por cada "\n". */
  async #readLoop(port) {
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    while (port.readable && !finished && !this.#closing) {
      this.#reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.#reader.read();
          if (done) {
            finished = true;
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const text = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            if (text) this.#emit('line', { text });
          }
          if (buffer.length > 4096) buffer = buffer.slice(-1024); // evita crecer con ruido
        }
      } catch (error) {
        // Errores no fatales (framing, overrun): si el puerto sigue legible, se reintenta.
        if (!this.#closing) this.#emit('error', { error });
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        this.#reader.releaseLock();
        this.#reader = null;
      }
    }

    // Si la lectura terminó sin que el usuario lo pidiera, el puerto se perdió.
    if (!this.#closing && this.#port === port) this.#teardown('Se perdió la conexión con el ESP32');
  }

  /** Libera reader, writer y puerto en el orden correcto. Es idempotente. */
  async #teardown(reason) {
    if (!this.#port || this.#closing) return;
    this.#closing = true;
    const port = this.#port;

    try {
      await this.#reader?.cancel();
    } catch {
      /* el stream ya estaba cerrado */
    }
    await this.#readTask?.catch(() => {});
    await this.#queue.catch(() => {});
    try {
      this.#writer?.releaseLock();
    } catch {
      /* ya liberado */
    }
    try {
      await port.close();
    } catch (error) {
      if (reason.startsWith('Desconectado por')) this.#emit('error', { error });
    }

    this.#port = null;
    this.#writer = null;
    this.#readTask = null;
    this.#queue = Promise.resolve();
    this.#emit('state', { state: 'disconnected', reason });
  }

  /** Serializa escrituras para que un JSON nunca se mezcle con un frame binario. */
  #exclusive(task) {
    if (!this.#writer) return Promise.reject(new Error('No hay un ESP32 conectado.'));
    const job = this.#queue.then(task);
    this.#queue = job.catch(() => {});
    return job;
  }

  sendJson(command) {
    return this.#exclusive(() => this.#writer.write(encodeJsonCommand(command)));
  }

  /** Envía cabecera + payload en bloques; `onProgress(enviados, total)` cuenta bytes del payload. */
  sendFrame(header, payload, { onProgress } = {}) {
    return this.#exclusive(async () => {
      await this.#writer.write(header);
      let sent = 0;
      onProgress?.(0, payload.length);
      for (const block of chunkPayload(payload)) {
        await this.#writer.write(block);
        sent += block.length;
        onProgress?.(sent, payload.length);
      }
    });
  }
}
