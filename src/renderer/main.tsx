import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { AppProvider } from './app/store';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('The application root is missing.');

createRoot(container).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>
);
