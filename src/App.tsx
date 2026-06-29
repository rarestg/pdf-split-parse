import { useCallback, useEffect, useState } from 'react';
import { ApiKeyInput } from './components/ApiKeyInput';
import { Controls, type Settings } from './components/Controls';
import { FileDrop, type LoadedPdf } from './components/FileDrop';
import { Progress } from './components/Progress';
import { ResultView } from './components/ResultView';
import { useOcrJob } from './hooks/useOcrJob';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MEDIA_RESOLUTION,
  DEFAULT_MODEL,
  listModels,
  type GeminiModel,
} from './core';

const SESSION_KEY = 'pdf-split-parse:gemini-key';

export function App() {
  const [apiKey, setApiKey] = useState('');
  const [rememberKey, setRememberKey] = useState(false);
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [settings, setSettings] = useState<Settings>({
    model: DEFAULT_MODEL,
    concurrency: DEFAULT_CONCURRENCY,
    mediaResolution: DEFAULT_MEDIA_RESOLUTION,
    startPage: 1,
    endPage: 1,
    prompt: '',
  });
  const [models, setModels] = useState<GeminiModel[]>([]);
  const [modelsState, setModelsState] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null,
  });
  const [formError, setFormError] = useState<string | null>(null);

  const { state: job, run, cancel, reset } = useOcrJob();
  const isRunning = job.status === 'running';

  // Restore a per-tab key on mount.
  useEffect(() => {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      setApiKey(stored);
      setRememberKey(true);
    }
  }, []);

  // Persist or clear the per-tab key whenever it (or the toggle) changes.
  useEffect(() => {
    if (rememberKey && apiKey) sessionStorage.setItem(SESSION_KEY, apiKey);
    else sessionStorage.removeItem(SESSION_KEY);
  }, [rememberKey, apiKey]);

  const updateSettings = useCallback((partial: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  const handlePdf = useCallback(
    (loaded: LoadedPdf) => {
      setPdf(loaded);
      setSettings((prev) => ({ ...prev, startPage: 1, endPage: loaded.pageCount }));
      setFormError(null);
      reset();
    },
    [reset],
  );

  const loadModels = useCallback(async () => {
    if (!apiKey.trim()) {
      setModelsState({ loading: false, error: 'Enter your API key first.' });
      return;
    }
    setModelsState({ loading: true, error: null });
    try {
      const found = await listModels(apiKey.trim());
      setModels(found);
      setModelsState({ loading: false, error: found.length ? null : 'No usable models for this key.' });
      if (found.length && !found.some((model) => model.name === settings.model)) {
        const flash = found.find((model) => /flash/i.test(model.name)) ?? found[0];
        updateSettings({ model: flash.name });
      }
    } catch (error) {
      setModelsState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }, [apiKey, settings.model, updateSettings]);

  const handleRun = useCallback(async () => {
    if (!pdf) {
      setFormError('Choose a PDF first.');
      return;
    }
    if (!apiKey.trim()) {
      setFormError('Enter your Gemini API key.');
      return;
    }
    const startPage = Math.max(1, settings.startPage);
    const endPage = Math.min(settings.endPage, pdf.pageCount);
    if (endPage < startPage) {
      setFormError('End page must be greater than or equal to start page.');
      return;
    }
    setFormError(null);
    await run(pdf.bytes, pdf.file.name, {
      apiKey: apiKey.trim(),
      model: settings.model,
      prompt: settings.prompt.trim() || undefined,
      mediaResolution: settings.mediaResolution,
      concurrency: settings.concurrency,
      startPage,
      endPage,
    });
  }, [pdf, apiKey, settings, run]);

  const canRun = Boolean(apiKey.trim() && pdf && !isRunning);
  const selectedPages = pdf
    ? Math.max(0, Math.min(settings.endPage, pdf.pageCount) - Math.max(1, settings.startPage) + 1)
    : 0;
  const largeJob = selectedPages > 50;

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          PDF <span className="arrow">→</span> Markdown
        </h1>
        <p className="tagline">
          Client-side OCR powered by your own Google Gemini key. Your key and documents stay in your
          browser — the only network calls go straight to Google.
        </p>
      </header>

      <ApiKeyInput apiKey={apiKey} onApiKey={setApiKey} remember={rememberKey} onRemember={setRememberKey} />

      <FileDrop onPdf={handlePdf} current={pdf} disabled={isRunning} />

      <Controls
        settings={settings}
        onChange={updateSettings}
        pageCount={pdf?.pageCount ?? 0}
        disabled={isRunning}
        models={models}
        modelsLoading={modelsState.loading}
        modelsError={modelsState.error}
        onLoadModels={() => void loadModels()}
      />

      <div className="run-row">
        <button type="button" className="primary-btn big" onClick={() => void handleRun()} disabled={!canRun}>
          {isRunning ? 'Running…' : 'Convert to Markdown'}
        </button>
        {formError && <span className="error-text">{formError}</span>}
      </div>

      {largeJob && !isRunning && (
        <p className="hint">
          Large job: {selectedPages} pages will be sent to Gemini one request each. Free-tier keys may
          hit rate limits, and large PDFs use significant browser memory — consider a smaller page range
          or a paid-tier key.
        </p>
      )}

      <Progress
        status={job.status}
        completed={job.completed}
        total={job.total}
        failed={job.failed}
        results={job.results}
        onCancel={cancel}
      />

      {job.status === 'error' && <p className="error-text big-error">Error: {job.error}</p>}

      {(job.status === 'done' || job.status === 'cancelled') && job.markdown && (
        <ResultView markdown={job.markdown} fileName={pdf?.file.name ?? 'document.pdf'} />
      )}

      <footer className="app-footer">
        Pages are sent directly from your browser to Google Gemini. This site has no server and stores
        nothing.
      </footer>
    </div>
  );
}
