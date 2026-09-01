import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: {
    host: true, // Esponi sulla rete locale
    allowedHosts: true, // Permetti tunnel esterni come localtunnel
    proxy: {
      '/api': 'http://127.0.0.1:3001'
    }
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        console: resolve(__dirname, 'console.html'),
      }
    }
  }
});
