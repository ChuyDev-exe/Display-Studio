import { defineConfig } from 'vite';

// Web Serial solo funciona en contextos seguros: localhost o HTTPS.
export default defineConfig({
  server: { host: 'localhost', port: 5173 },
  build: { target: 'es2022' },
});
