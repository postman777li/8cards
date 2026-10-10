import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

function App() {
  return (
    <main>
      <h1>永城八张在线版</h1>
      <p>工程基础结构已就绪。</p>
    </main>
  );
}

const rootElement = document.querySelector('#root');

if (!rootElement) {
  throw new Error('找不到应用挂载节点');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
