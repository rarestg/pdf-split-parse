import { useCallback, useState } from 'react';
import type { CompletionSummary } from './useOcrJob';

const KEY = 'pdf-split-parse:lifetime';

export interface LifetimeStats {
  totalCostUsd: number;
  totalPages: number;
  totalPdfs: number;
}

const EMPTY: LifetimeStats = { totalCostUsd: 0, totalPages: 0, totalPdfs: 0 };

function read(): LifetimeStats {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LifetimeStats> | null;
    if (!raw) return EMPTY;
    return {
      totalCostUsd: Number(raw.totalCostUsd) || 0,
      totalPages: Number(raw.totalPages) || 0,
      totalPdfs: Number(raw.totalPdfs) || 0,
    };
  } catch {
    return EMPTY;
  }
}

/**
 * A running spend tally across conversions, persisted in localStorage. Stores ONLY these three
 * aggregate numbers — never a key, filename, or any document content.
 */
export function useLifetimeStats() {
  const [stats, setStats] = useState<LifetimeStats>(read);

  const record = useCallback((summary: CompletionSummary) => {
    setStats((prev) => {
      const cost = Number.isFinite(summary.costUsd) ? summary.costUsd : 0; // never let an unpriced/NaN poison the total
      const next: LifetimeStats = {
        totalCostUsd: prev.totalCostUsd + cost,
        totalPages: prev.totalPages + (summary.isRetry ? 0 : summary.pages),
        totalPdfs: prev.totalPdfs + (summary.isRetry || summary.pages === 0 ? 0 : 1),
      };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable (e.g. private mode) — keep the in-memory tally only */
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    setStats(EMPTY);
  }, []);

  return { stats, record, reset };
}
