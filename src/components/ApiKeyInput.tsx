import { useState } from 'react';

interface Props {
  apiKey: string;
  onApiKey: (value: string) => void;
  remember: boolean;
  onRemember: (value: boolean) => void;
}

export function ApiKeyInput({ apiKey, onApiKey, remember, onRemember }: Props) {
  const [reveal, setReveal] = useState(false);

  return (
    <section className="panel">
      <label className="field-label" htmlFor="api-key">
        Gemini API key
      </label>
      <div className="key-row">
        <input
          id="api-key"
          type={reveal ? 'text' : 'password'}
          className="text-input"
          placeholder="Paste your Google AI Studio key"
          value={apiKey}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onApiKey(event.target.value)}
        />
        <button type="button" className="ghost-btn" onClick={() => setReveal((value) => !value)}>
          {reveal ? 'Hide' : 'Show'}
        </button>
      </div>
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
        . Free-tier keys may have submitted content retained by Google; use a paid-tier key for sensitive
        documents.
      </p>
    </section>
  );
}
