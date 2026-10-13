import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@8cards/ui/styles.css';
import { App } from './App.js';
import './styles.css';

const rootElement = document.querySelector('#root');

if (!rootElement) {
  throw new Error('找不到应用挂载节点');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
