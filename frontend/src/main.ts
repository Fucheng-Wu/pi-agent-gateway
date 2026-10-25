import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import '@fontsource-variable/noto-sans-sc'
import './style.css'

createApp(App).use(createPinia()).mount('#app')
