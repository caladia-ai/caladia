import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { useDomainStore } from './store/domainStore.js';
import { loadAutosaved, startAutosave } from './lib/autosave.js';

async function bootstrap(): Promise<void> {
  // Restore the last autosaved project, if any, BEFORE the first render.
  const saved = await loadAutosaved();
  if (saved) {
    useDomainStore.setState({ project: saved });
    // The setState above fired handleSet and pushed a history entry whose
    // past state was the default project. Undoing into that is surprising,
    // so clear history once the restore is applied.
    useDomainStore.temporal.getState().clear();
  }

  // Start debounced autosave subscription.
  startAutosave();

  const root = document.getElementById('root');
  if (!root) throw new Error('Root element #root not found');

  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}

void bootstrap();
