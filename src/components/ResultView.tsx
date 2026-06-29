import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  markdown: string;
  fileName: string;
}

export function ResultView({ markdown, fileName }: Props) {
  const [tab, setTab] = useState<'preview' | 'source'>('preview');
  const [copied, setCopied] = useState(false);

  const download = () => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${fileName.replace(/\.pdf$/i, '')}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <section className="panel result">
      <div className="row-between">
        <div className="tabs">
          <button
            type="button"
            className={tab === 'preview' ? 'tab active' : 'tab'}
            onClick={() => setTab('preview')}
          >
            Preview
          </button>
          <button
            type="button"
            className={tab === 'source' ? 'tab active' : 'tab'}
            onClick={() => setTab('source')}
          >
            Markdown
          </button>
        </div>
        <div className="actions">
          <button type="button" className="ghost-btn" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="primary-btn" onClick={download}>
            Download .md
          </button>
        </div>
      </div>
      {tab === 'preview' ? (
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
        </div>
      ) : (
        <textarea className="source-area" readOnly value={markdown} />
      )}
    </section>
  );
}
