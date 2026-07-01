import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ApiKeyInput, type TestState } from './components/ApiKeyInput';
import { Controls, type Settings } from './components/Controls';
import { CostSummary } from './components/CostSummary';
import { FileDrop, type LoadedPdf } from './components/FileDrop';
import { Progress } from './components/Progress';
import { ResultView } from './components/ResultView';
import { RetryPanel } from './components/RetryPanel';
import { SwapLabel } from './components/SwapLabel';
import { ThemeToggle, type Theme } from './components/ThemeToggle';
import { useLifetimeStats } from './hooks/useLifetimeStats';
import { useOcrJob } from './hooks/useOcrJob';
import {
  checkApiKey,
  DEFAULT_CONCURRENCY,
  DEFAULT_MEDIA_RESOLUTION,
  DEFAULT_PROMPT,
  DEFAULT_TIMEOUT_MS,
  formatCost,
  pickCheapestModel,
  type GeminiModel,
} from './core';

const SESSION_KEY = 'pdf-split-parse:gemini-key';
const THEME_KEY = 'pdf-split-parse:theme';

// Shown (behind the lock) before a key is tested; replaced by the key's real
// models after "Test". Role tags are derived from the id in Controls.
const FALLBACK_MODELS: GeminiModel[] = [
  { name: 'gemini-2.5-flash-lite' },
  { name: 'gemini-2.5-flash' },
  { name: 'gemini-2.5-pro' },
];

export function App() {
  const [apiKey, setApiKey] = useState('');
  const [rememberKey, setRememberKey] = useState(false);
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [settings, setSettings] = useState<Settings>({
    model: FALLBACK_MODELS[0].name,
    concurrency: DEFAULT_CONCURRENCY,
    timeoutSec: DEFAULT_TIMEOUT_MS / 1000,
    mediaResolution: DEFAULT_MEDIA_RESOLUTION,
    startPage: 1,
    endPage: 1,
    prompt: DEFAULT_PROMPT,
  });
  const [models, setModels] = useState<GeminiModel[]>(FALLBACK_MODELS);
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });
  const [formError, setFormError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    } catch {
      /* storage blocked (e.g. privacy mode) — fall through to system */
    }
    return 'system';
  });

  // Apply the theme to <html> (matching the pre-paint script), persist the choice,
  // and follow OS changes only while on "system". Key absent = system.
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (dark: boolean) => {
      root.classList.toggle('dark', dark);
      root.style.colorScheme = dark ? 'dark' : 'light';
    };
    apply(theme === 'dark' || (theme === 'system' && media.matches));
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage blocked — the theme still applies for this session */
    }
    if (theme !== 'system') return;
    const onChange = (event: MediaQueryListEvent) => apply(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  const lifetime = useLifetimeStats();
  const { state: job, run, retry, cancel, reset } = useOcrJob(lifetime.record);
  const isRunning = job.status === 'running';

  // One-shot "rising sun" burst behind the page, fired from the Convert button's
  // center on run. Mounted only while it plays (~1.8s), then unmounted.
  const [burst, setBurst] = useState<{ x: number; y: number; size: number; k: number } | null>(null);
  const runBtnRef = useRef<HTMLButtonElement>(null);
  const sunburstRef = useRef<HTMLDivElement>(null);
  const burstTimer = useRef<number>();
  const burstId = useRef(0);
  useEffect(() => () => clearTimeout(burstTimer.current), []);

  // Sun origin = the Convert button's viewport center; `reach` is the farthest
  // screen corner so the rays cover the viewport wherever the button sits.
  const measureBurst = useCallback(() => {
    const btn = runBtnRef.current;
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const reach = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    return { x, y, size: reach * 2.2 };
  }, []);

  // A full re-run unmounts result panels in the SAME commit that mounts the burst,
  // which can collapse the page and clamp the scroll, shifting the button's viewport
  // position. Re-measure after that commit (before paint, while the rays are still
  // opacity:0) so the sun anchors to the button's post-reflow spot, not stale coords.
  useLayoutEffect(() => {
    if (!burst) return;
    const m = measureBurst();
    const node = sunburstRef.current;
    if (!m || !node) return;
    node.style.setProperty('--sun-x', `${m.x}px`);
    node.style.setProperty('--sun-y', `${m.y}px`);
    node.style.setProperty('--burst-size', `${m.size}px`);
  }, [burst, measureBurst]);

  // Keep the (tall) result view mounted during a re-run by caching the last settled
  // markdown, so the page doesn't collapse and jog the scroll out from under the
  // button. Cleared when a new PDF is loaded (handlePdf).
  const [lastMarkdown, setLastMarkdown] = useState('');
  useEffect(() => {
    if ((job.status === 'done' || job.status === 'cancelled') && job.markdown) setLastMarkdown(job.markdown);
  }, [job.status, job.markdown]);

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

  const handleApiKey = useCallback(
    (value: string) => {
      setApiKey(value);
      setTestState({ status: 'idle' }); // a changed key needs a fresh test
      setModels(FALLBACK_MODELS); // the new key's models are unknown until Test
      updateSettings({ model: FALLBACK_MODELS[0].name }); // don't run a model the old key revealed
    },
    [updateSettings],
  );

  const handlePdf = useCallback(
    (loaded: LoadedPdf) => {
      setPdf(loaded);
      setSettings((prev) => ({ ...prev, startPage: 1, endPage: loaded.pageCount }));
      setFormError(null);
      setLastMarkdown('');
      reset();
    },
    [reset],
  );

  const handleTest = useCallback(async () => {
    const key = apiKey.trim();
    if (!key) {
      setTestState({ status: 'error', message: 'Enter your API key first.' });
      return;
    }
    setTestState({ status: 'testing' });
    try {
      const { models: found, testedModel, elapsedMs, tested, note } = await checkApiKey(key);
      if (found.length) {
        setModels(found);
        updateSettings({ model: pickCheapestModel(found) ?? testedModel });
      }
      setTestState({
        status: 'ok',
        message: tested
          ? `Tested ${testedModel} in ${(elapsedMs / 1000).toFixed(1)}s · ${found.length} models available`
          : note ?? `Key valid · ${found.length} models available`,
      });
    } catch (error) {
      setTestState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, [apiKey, updateSettings]);

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
    // Fire the rising-sun burst from the button's center (re-anchored post-commit
    // by the layout effect, in case the re-run collapses the page below it).
    const m = measureBurst();
    if (m) {
      setBurst({ ...m, k: ++burstId.current });
      clearTimeout(burstTimer.current);
      burstTimer.current = window.setTimeout(() => setBurst(null), 1900);
    }
    await run(pdf.bytes, pdf.file.name, {
      apiKey: apiKey.trim(),
      model: settings.model,
      prompt: settings.prompt.trim() || undefined,
      mediaResolution: settings.mediaResolution,
      concurrency: settings.concurrency,
      timeoutMs: settings.timeoutSec * 1000,
      startPage,
      endPage,
    });
  }, [pdf, apiKey, settings, run, measureBurst]);

  const canRun = Boolean(apiKey.trim() && pdf && !isRunning);
  const selectedPages = pdf
    ? Math.max(0, Math.min(settings.endPage, pdf.pageCount) - Math.max(1, settings.startPage) + 1)
    : 0;
  const largeJob = selectedPages > 50;
  const settled = job.status === 'done' || job.status === 'cancelled';
  // A re-OCR is in flight while we still hold the prior document (so panels stay visible, not vanish).
  const reOcr = isRunning && job.markdown !== '';
  const flaggedPages = job.results.filter((r) => r.error || r.warning).map((r) => r.pageNumber);
  const failedPages = job.results.filter((r) => r.error).map((r) => r.pageNumber);
  const suspectPages = job.results.filter((r) => r.warning && !r.error).map((r) => r.pageNumber);
  const lr = job.lastRetry;
  const lastRetryOutcome = !lr
    ? ''
    : lr.remaining > 0
      ? `${lr.fixed} fixed, ${lr.remaining} still flagged`
      : lr.fixed > 0
        ? `all ${lr.fixed} fixed`
        : 'none were flagged';

  return (
    <div className="app">
      {burst && (
        <div
          ref={sunburstRef}
          key={burst.k}
          className="sunburst"
          aria-hidden="true"
          style={
            {
              '--sun-x': `${burst.x}px`,
              '--sun-y': `${burst.y}px`,
              '--burst-size': `${burst.size}px`,
            } as CSSProperties
          }
        />
      )}
      <ThemeToggle theme={theme} onTheme={setTheme} />
      <header className="app-header">
        <h1>
          PDF <span className="arrow">→</span> Markdown
        </h1>
        <p className="tagline">
          Split a PDF and OCR every page in parallel (up to 128 at once!), straight from your browser to
          Gemini. A whole book can finish in under a minute, and your key and documents only ever go to
          Gemini&rsquo;s GPUs, never to us.
        </p>
      </header>

      <ApiKeyInput
        apiKey={apiKey}
        onApiKey={handleApiKey}
        remember={rememberKey}
        onRemember={setRememberKey}
        onTest={() => void handleTest()}
        testState={testState}
      />

      <FileDrop onPdf={handlePdf} current={pdf} disabled={isRunning} />

      <Controls
        settings={settings}
        onChange={updateSettings}
        pageCount={pdf?.pageCount ?? 0}
        selectedPages={selectedPages}
        disabled={isRunning}
        models={models}
        keyTested={testState.status === 'ok'}
      />

      <div className="run-row">
        <button ref={runBtnRef} type="button" className="primary-btn big" onClick={() => void handleRun()} disabled={!canRun}>
          <SwapLabel options={['Convert to Markdown', 'Running…']}>
            {isRunning ? 'Running…' : 'Convert to Markdown'}
          </SwapLabel>
        </button>
        {formError && <span className="error-text">{formError}</span>}
      </div>

      {largeJob && !isRunning && (
        <p className="hint">
          Large job: {selectedPages} pages, one Gemini request each. Very large PDFs use significant
          browser memory. If the tab struggles, lower the parallel-pages count or split the range.
        </p>
      )}

      {job.status !== 'idle' && (
        <section className="panel">
          <Progress
            status={job.status}
            completed={job.completed}
            total={job.total}
            failed={job.failed}
            inFlight={job.inFlight}
            retrying={job.retrying}
            results={job.results}
            startedAt={job.startedAt}
            elapsedMs={job.elapsedMs}
            retryElapsedMs={job.retryElapsedMs}
            reOcr={reOcr}
            onCancel={cancel}
          />
          {(settled || reOcr || job.status === 'error') && (
            <CostSummary
              results={job.results}
              costByModel={job.costByModel}
              model={job.model}
              mediaResolution={job.mediaResolution}
            />
          )}
          {job.lastRetry && (
            <p className="hint last-retry">
              Last retry: page{job.lastRetry.pages.length === 1 ? '' : 's'} {job.lastRetry.pages.join(', ')} on{' '}
              {job.lastRetry.model} ({job.lastRetry.mediaResolution}) — {lastRetryOutcome}.
            </p>
          )}
        </section>
      )}

      {job.status === 'error' && <p className="error-text big-error">Error: {job.error}</p>}

      {(settled || reOcr) &&job.results.length > 0 && (
        <RetryPanel
          models={models}
          usedModel={job.model}
          usedDetail={job.mediaResolution}
          flaggedPages={flaggedPages}
          failedPages={failedPages}
          suspectPages={suspectPages}
          pageCount={pdf?.pageCount ?? job.total}
          disabled={isRunning}
          error={job.actionError}
          onRetry={(pages, model, detail) => void retry(pages, { model, mediaResolution: detail })}
        />
      )}

      {(((settled || reOcr) && job.markdown) || (isRunning && lastMarkdown)) && (
        <ResultView markdown={job.markdown || lastMarkdown} fileName={pdf?.file.name ?? 'document.pdf'} />
      )}

      {(lifetime.stats.totalPdfs > 0 || lifetime.stats.totalCostUsd > 0) && (
        <p className="hint lifetime">
          Lifetime on this device: <strong>{formatCost(lifetime.stats.totalCostUsd)}</strong> across{' '}
          {lifetime.stats.totalPages.toLocaleString()} page{lifetime.stats.totalPages === 1 ? '' : 's'} ·{' '}
          {lifetime.stats.totalPdfs} conversion{lifetime.stats.totalPdfs === 1 ? '' : 's'}{' '}
          <button type="button" className="reset-pill" onClick={lifetime.reset}>
            reset
          </button>
        </p>
      )}

      <footer className="app-footer">
        <p>
          Pages go straight from your browser to Gemini&rsquo;s GPUs. This site has no server, so your
          documents and key never touch it; the only thing persisted between visits is an anonymous cost
          tally (no documents, filenames, or keys).
        </p>
        <p className="footer-credit">
          Made with love from the Capital One Lounge in Union Square
          <br />© Rareș Gosman ·{' '}
          <a href="https://rares.blog" target="_blank" rel="noreferrer">
            rares.blog
          </a>
        </p>
      </footer>
    </div>
  );
}
