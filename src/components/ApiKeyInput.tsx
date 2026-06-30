import { useState } from 'react';
import { SwapLabel } from './SwapLabel';

export interface TestState {
  status: 'idle' | 'testing' | 'ok' | 'error';
  message?: string;
}

interface Props {
  apiKey: string;
  onApiKey: (value: string) => void;
  remember: boolean;
  onRemember: (value: boolean) => void;
  onTest: () => void;
  testState: TestState;
}

// Solid status icons: a filled disc in the status color (currentColor) with the
// glyph knocked out in the panel color (.glyph, styled in CSS).
function CircleCheckSolid() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path
        className="glyph"
        d="M8 12.2l2.6 2.6L16 9.2"
        fill="none"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CircleXSolid() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path className="glyph" d="M14.8 9.2l-5.6 5.6M9.2 9.2l5.6 5.6" fill="none" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function ApiKeyInput({ apiKey, onApiKey, remember, onRemember, onTest, testState }: Props) {
  const [reveal, setReveal] = useState(false);

  return (
    <section className="panel">
      <label className="field-label" htmlFor="api-key">
        Gemini API key
      </label>
      <div className="key-row">
        {/* type=text + CSS masking (not type=password) so password managers don't offer
            to save/update it; the key never needs to be a browser-stored credential. */}
        <input
          id="api-key"
          type="text"
          className={`text-input${reveal ? '' : ' masked'}`}
          placeholder="Paste your Google AI Studio key"
          value={apiKey}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          data-1p-ignore="true"
          data-lpignore="true"
          onChange={(event) => onApiKey(event.target.value)}
        />
        <button type="button" className="ghost-btn" onClick={() => setReveal((value) => !value)}>
          <SwapLabel options={['Show', 'Hide']}>{reveal ? 'Hide' : 'Show'}</SwapLabel>
        </button>
        <button
          type="button"
          className="primary-btn"
          onClick={onTest}
          disabled={!apiKey.trim() || testState.status === 'testing'}
        >
          <SwapLabel options={['Test', 'Testing…']}>
            {testState.status === 'testing' ? 'Testing…' : 'Test'}
          </SwapLabel>
        </button>
      </div>

      {testState.status === 'ok' && (
        <p className="status-ok status-line">
          <CircleCheckSolid />
          <span>{testState.message}</span>
        </p>
      )}
      {testState.status === 'error' && (
        <p className="status-err status-line">
          <CircleXSolid />
          <span>{testState.message}</span>
        </p>
      )}

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => onRemember(event.target.checked)}
        />
        Remember in this browser tab
      </label>
      <p className="hint">
        Your key stays in your browser and is sent only to Google&rsquo;s Gemini API — never to us. This
        app has no backend.{' '}
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
          Get a key
        </a>
        . Bring a paid key: free-tier keys are rate-limited (so much for going parallel) and their content
        may be human-reviewed by Google, while paid Gemini API content isn&rsquo;t used to improve Google&rsquo;s
        products.
      </p>
    </section>
  );
}
