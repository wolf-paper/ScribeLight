import './app.css';
import App from './App.svelte';
import { mount } from 'svelte';

const mountApp = (props = {}) => mount(App, {
  target: document.getElementById('app')!, props
});

const app = import.meta.env.MODE === 'test'
  ? import('./test/browserFakeBridge').then(({ browserTestProps }) => mountApp(browserTestProps()))
  : mountApp();

export default app;
