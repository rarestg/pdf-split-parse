import { useCallback, useRef, useState } from 'react';
import { getPageCount } from '../core';
import { withLoadingIndicator } from './withLoadingIndicator';

export interface LoadedPdf {
  file: File;
  bytes: Uint8Array;
  pageCount: number;
}

interface Props {
  onPdf: (pdf: LoadedPdf) => void;
  current: LoadedPdf | null;
  disabled?: boolean;
}

export function FileDrop({ onPdf, current, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loading = useRef(false);

  const load = useCallback(
    async (getFile: () => Promise<File>) => {
      // The sample button only looks disabled once the indicator shows, so a double click lands here.
      if (loading.current) return;
      loading.current = true;
      setError(null);
      try {
        const pdf = await withLoadingIndicator(async () => {
          const file = await getFile();
          const bytes = new Uint8Array(await file.arrayBuffer());
          return { file, bytes, pageCount: await getPageCount(bytes) };
        }, setBusy);
        onPdf(pdf);
      } catch (err) {
        console.error('PDF read failed:', err); // raw detail for debugging; users see the message below
        setError(err instanceof Error ? err.message : 'This PDF couldn’t be read.');
      } finally {
        loading.current = false;
      }
    },
    [onPdf],
  );

  const ingest = useCallback(
    async (file: File) => {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        setError('Please choose a PDF file.');
        return;
      }
      await load(async () => file);
    },
    [load],
  );

  const loadSample = useCallback(
    () =>
      load(async () => {
        try {
          const response = await fetch(`${import.meta.env.BASE_URL}sample.pdf`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return new File([await response.blob()], 'sample.pdf', { type: 'application/pdf' });
        } catch (cause) {
          throw new Error('Could not load the sample PDF.', { cause });
        }
      }),
    [load],
  );

  const openPicker = () => {
    if (!disabled) inputRef.current?.click();
  };

  return (
    <section className="panel">
      {/* biome-ignore lint/a11y/useSemanticElements: a <button> can't contain the dropzone's file input. */}
      <div
        className={`dropzone${dragOver ? ' drag' : ''}${disabled ? ' disabled' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          if (disabled) return;
          const file = event.dataTransfer.files?.[0];
          if (file) void ingest(file);
        }}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPicker();
          }
        }}
        role="button"
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void ingest(file);
            event.target.value = '';
          }}
        />
        {busy ? (
          <p>
            <span className="spinner" aria-hidden="true" />
            Reading PDF…
          </p>
        ) : current ? (
          <p>
            <strong>{current.file.name}</strong>
            <br />
            <span className="muted">
              {current.pageCount} page{current.pageCount === 1 ? '' : 's'} · {(current.file.size / 1024).toFixed(0)} KB
              · click to replace
            </span>
          </p>
        ) : (
          <p>Drop a PDF here, or click to choose</p>
        )}
      </div>
      <div className="row-between">
        <button type="button" className="ghost-btn" onClick={() => void loadSample()} disabled={disabled || busy}>
          Try the sample PDF
        </button>
      </div>
      {error && (
        <p className="error-text big-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
