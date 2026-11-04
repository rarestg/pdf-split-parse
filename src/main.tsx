import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Fetch pdf-lib once the page is up, so the first PDF opens without a wait and this tab keeps working after a deploy
// removes the old chunk. A failure needs no handling here: loadPdf shows the reload message when a PDF needs pdf-lib.
window.addEventListener('load', () => void import('pdf-lib').catch(() => {}), { once: true });
