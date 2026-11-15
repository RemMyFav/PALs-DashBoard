import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/auth': 'http://backend:4000',
      '/api': 'http://backend:4000',
    },
  },
});
