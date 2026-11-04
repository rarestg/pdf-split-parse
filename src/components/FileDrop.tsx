import { useCallback, useRef, useState } from 'react';
import { getPageCount } from '../core';

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

  const ingest = useCallback(
    async (file: File) => {
      setError(null);
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        setError('Please choose a PDF file.');
        return;
      }
      setBusy(true);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const pageCount = await getPageCount(bytes);
        onPdf({ file, bytes, pageCount });
      } catch (err) {
        console.error('PDF read failed:', err); // raw detail for debugging; users see the message below
        setError(err instanceof Error ? err.message : 'This PDF couldn’t be read.');
      } finally {
        setBusy(false);
      }
    },
    [onPdf],
  );

  const loadSample = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}sample.pdf`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const pageCount = await getPageCount(bytes);
      onPdf({ file: new File([bytes], 'sample.pdf', { type: 'application/pdf' }), bytes, pageCount });
    } catch {
      setError('Could not load the sample PDF.');
    } finally {
      setBusy(false);
    }
  }, [onPdf]);

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
          <p>Reading PDF…</p>
        ) : current ? (
          <p>
            <strong>{current.file.name}</strong>
            <br />
            <span className="muted">
              {current.pageCount} page{current.pageCount === 1 ? '' : 's'} ·{' '}
              {(current.file.size / 1024).toFixed(0)} KB · click to replace
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
