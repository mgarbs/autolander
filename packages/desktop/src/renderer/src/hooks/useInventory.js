import { useState, useEffect, useCallback } from 'react';
import { getInventory } from '../api/client';

export function useInventory() {
  const [inventory, setInventory] = useState({ vehicles: [], meta: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getInventory();
      setInventory(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { inventory, loading, error, refresh };
}
