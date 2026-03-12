import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBaseUrl } from '../api/client';
import { useRealtime } from '../context/RealtimeContext';
import { Calendar, RefreshCw, Clock, User, Car } from 'lucide-react';

export default function Appointments() {
  const navigate = useNavigate();
  const { lastEvents } = useRealtime();
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef(null);

  const [convMap, setConvMap] = useState({});

  const load = useCallback(async (showLoading = true, signal) => {
    if (showLoading) setLoading(true);
    const base = getBaseUrl();
    const token = localStorage.getItem('accessToken');
    try {
      const [apptRes, convRes] = await Promise.all([
        fetch(`${base}/api/appointments`, { headers: { Authorization: `Bearer ${token}` }, signal }),
        fetch(`${base}/api/conversations`, { headers: { Authorization: `Bearer ${token}` }, signal }),
      ]);
      const apptData = await apptRes.json();
      const convData = await convRes.json();
      setAppointments(apptData.appointments || []);
      // Build buyerName -> conversationId lookup
      const map = {};
      (Array.isArray(convData) ? convData : []).forEach(c => {
        if (c.buyerName) map[c.buyerName.toLowerCase()] = c.id;
      });
      setConvMap(map);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Failed to load appointments:', err);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    load(true, ac.signal);
    return () => ac.abort();
  }, [load]);

  useEffect(() => {
    if (lastEvents.appointment) {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      load(false, ac.signal);
    }
  }, [lastEvents.appointment, load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="page-transition space-y-6">
      <h1 className="text-2xl font-bold text-white">Appointments</h1>

      {appointments.length === 0 ? (
        <div className="glass-card p-8 text-center text-surface-400">
          No appointments scheduled yet.
        </div>
      ) : (
        <div className="space-y-3">
          {appointments.map((appt) => {
            const convId = convMap[appt.buyerName?.toLowerCase()];
            return (
            <div
              key={appt.id}
              onClick={() => convId && navigate(`/leads/${convId}`)}
              className={`glass-card p-4 flex items-center justify-between ${convId ? 'cursor-pointer hover:border-brand-500/30 transition-all' : ''}`}
            >
              <div>
                <p className="text-white font-medium">{appt.buyerName}</p>
                <p className="text-surface-400 text-sm">
                  {new Date(appt.scheduledTime).toLocaleString()}
                </p>
                {appt.vehicle && (
                  <p className="text-surface-500 text-xs">
                    {appt.vehicle.year} {appt.vehicle.make} {appt.vehicle.model}
                  </p>
                )}
              </div>
              <span className={`px-2 py-1 rounded text-xs font-medium ${
                appt.status === 'CONFIRMED' ? 'bg-green-500/20 text-green-400' :
                appt.status === 'CANCELLED' ? 'bg-red-500/20 text-red-400' :
                appt.status === 'COMPLETED' ? 'bg-blue-500/20 text-blue-400' :
                'bg-amber-500/20 text-amber-400'
              }`}>
                {appt.status}
              </span>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
