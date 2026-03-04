import { useState, useEffect } from 'react';
import { getBaseUrl } from '../api/client';

export default function Appointments() {
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const base = getBaseUrl();
    const token = localStorage.getItem('accessToken');
    fetch(`${base}/api/appointments`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => setAppointments(data.appointments || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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
          {appointments.map((appt) => (
            <div key={appt.id} className="glass-card p-4 flex items-center justify-between">
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
          ))}
        </div>
      )}
    </div>
  );
}
