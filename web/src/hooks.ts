import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

/** Fetch JSON from the API; reloads when the path or the facility changes. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setLoading(true);
    setError(null);
    api.get<T>(path)
      .then((d) => live && setData(d))
      .catch((e: ApiError) => live && e.status !== 401 && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);
  return { data, error, loading, reload, setData };
}

/** Run an action, keep its error message for display. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      const err = e as ApiError;
      const detail = err.errors?.length ? ` — ${err.errors.map((x) => `${x.unitRef ?? x.path ?? ''} ${x.message}`.trim()).join('; ')}` : '';
      setError(`${err.message}${detail}`);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}
