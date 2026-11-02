import { defineConfig } from 'vite';
import { resolve } from 'path';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Q-Skip Smart Canteen',
        short_name: 'Q-Skip',
        description: 'Smart Preorder Canteen Queue Management System',
        theme_color: '#ff4e6a',
        background_color: '#ff4e6a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/index.html',
        icons: [
          {
            src: 'https://cdn-icons-png.flaticon.com/512/3081/3081559.png',
            sizes: '192x192',
            type: 'image/png'
          }
        ]
      }
    })
  ],

  server: {
    port: 5173,
    host: true,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5001',
        changeOrigin: true,
        secure: false
      }
    }
  },

  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        menu: resolve(__dirname, 'menu.html'),
        cart: resolve(__dirname, 'cart.html'),
        payment: resolve(__dirname, 'payment.html'),
        tracking: resolve(__dirname, 'tracking.html')
      }
    }
  }
});