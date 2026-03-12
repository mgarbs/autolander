import { useState, useEffect, useCallback, useRef } from 'react';
import { getInventory } from '../api/client';

export function useInventory() {
  const [inventory, setInventory] = useState({ vehicles: [], meta: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const refresh = useCallback(async (signal) => {
    try {
      const data = await getInventory(signal ? { signal } : {});
      setInventory(data);
      setError(null);
    } catch (e) {
      if (e.name === 'AbortError') return;
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    refresh(ac.signal);
    const interval = setInterval(() => {
      const ic = new AbortController();
      abortRef.current = ic;
      refresh(ic.signal);
    }, 30000);
    return () => { ac.abort(); clearInterval(interval); };
  }, [refresh]);

  const manualRefresh = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    refresh(ac.signal);
  }, [refresh]);

  return { inventory, loading, error, refresh: manualRefresh };
}
