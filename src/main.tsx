import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './translate.css';
import './lightweight.css';
import './draggable.css';
import './empty-state.css';
import './disabled-state.css';
import './openmaic-settings.css';
import './dock.css';
import './import.css';
import './comparison.css';
import './product-ui.css';
import { initializeAppearance } from './uiTheme';

const disposeAppearance = initializeAppearance();
if (import.meta.hot) import.meta.hot.dispose(disposeAppearance);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
