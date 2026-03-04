import { useState, useEffect, useCallback } from 'react';
import { getLeads, getPipeline, rescoreLeads } from '../api/client';

export function useLeads(params = {}) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getLeads(params);
      setLeads(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [params.sentiment, params.limit]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { leads, loading, error, refresh };
}

export function usePipeline() {
  const [pipeline, setPipeline] = useState({ hot: 0, warm: 0, cold: 0, dead: 0 });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await getPipeline();
      setPipeline(data);
    } catch (e) {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { pipeline, loading, refresh };
}

export function useRescore() {
  const [rescoring, setRescoring] = useState(false);

  const rescore = useCallback(async () => {
    setRescoring(true);
    try {
      await rescoreLeads();
    } finally {
      setRescoring(false);
    }
  }, []);

  return { rescore, rescoring };
}
