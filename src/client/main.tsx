import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { normalizeBasePath } from '../shared/basePath';
import { App } from './App';
import { createPokerClient } from './socket';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Missing #root element');
const basePath = normalizeBasePath(import.meta.env.BASE_URL);

createRoot(root).render(
  <StrictMode>
    <App client={createPokerClient({ basePath })} basePath={basePath} />
  </StrictMode>,
);
