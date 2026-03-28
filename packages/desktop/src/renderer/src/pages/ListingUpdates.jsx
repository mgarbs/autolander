import { useEffect, useState } from 'react';
import { fetchJSON, toInventoryFormat, markVehicleUpdated } from '../api/client';
import Badge from '../components/Badge';
import {
  RefreshCw,
  AlertCircle,
  Car,
  ImageIcon,
  Loader2,
  CheckCircle2,
  ArrowLeft,
  DollarSign
} from 'lucide-react';

export default function ListingUpdates() {
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [updatingVin, setUpdatingVin] = useState(null);
  const [phase, setPhase] = useState('select'); // select | streaming | result
  const [resultData, setResultData] = useState(null);
  const [selectedVin, setSelectedVin] = useState(null);

  const fetchStaleVehicles = async () => {
    setLoading(true);
    try {
      const data = await fetchJSON('/api/vehicles?fbPosted=true&fbStale=true&status=ACTIVE');
      setVehicles((data.vehicles || []).map(toInventoryFormat));
    } catch (e) {
      console.error('Failed to fetch stale vehicles:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStaleVehicles();
  }, []);

  const handleUpdate = async (vehicle) => {
    if (updatingVin) return;
    setUpdatingVin(vehicle.vin);
    setSelectedVin(vehicle.vin);
    try {
      const listingUrl = vehicle.listings?.facebook_marketplace?.listingUrl;
      await window.autolander.fb.updateListing({ vehicle, listingUrl });
      setPhase('streaming');
    } catch (e) {
      alert(e.message || 'Failed to start update');
      setUpdatingVin(null);
    }
  };

  const handleResult = async (data) => {
    if (data && !data.error) {
      const vehicle = vehicles.find(v => v.vin === selectedVin);
      try {
        await markVehicleUpdated(vehicle.id);
      } catch (e) {
        console.error('Failed to update vehicle status:', e.message);
      }
    }
    setResultData(data);
    setPhase('result');
  };

  const handleBack = () => {
    setPhase('select');
    setSelectedVin(null);
    setUpdatingVin(null);
    setResultData(null);
    fetchStaleVehicles();
  };

  if (phase === 'streaming') {
    return <StreamingView onResult={handleResult} onCancel={handleBack} />;
  }

  if (phase === 'result') {
    return <ResultView data={resultData} onBack={handleBack} />;
  }

  return (
    <div className="space-y-8 pb-12 max-w-6xl">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-amber-500 font-bold text-xs uppercase tracking-widest">
          <RefreshCw size={14} />
          Listing Updates
        </div>
        <h1 className="text-4xl font-black text-white tracking-tight leading-none uppercase">
          Price <span className="text-amber-500">Changes</span>
        </h1>
        <p className="text-surface-500 font-medium max-w-lg">
          These listings have price changes in your inventory. Update them on Facebook Marketplace to stay synced.
        </p>
      </header>

      {loading ? (
        <div className="flex items-center justify-center py-20 opacity-30">
          <RefreshCw size={24} className="animate-spin" />
        </div>
      ) : vehicles.length === 0 ? (
        <div className="glass-card p-12 text-center border-emerald-500/20">
          <CheckCircle2 size={40} className="mx-auto mb-4 text-emerald-500" />
          <p className="text-surface-400 font-medium">All listings are up to date</p>
          <p className="text-surface-600 text-sm mt-1">Great job! No pending price updates found.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {vehicles.map(v => (
            <UpdateCard 
              key={v.vin} 
              v={v} 
              onUpdate={() => handleUpdate(v)}
              isUpdating={updatingVin === v.vin}
              disabled={!!updatingVin && updatingVin !== v.vin}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UpdateCard({ v, onUpdate, isUpdating, disabled }) {
  const reason = v.listings?.facebook_marketplace?.staleReason || '';
  const priceMatch = reason.match(/price_changed:([\d.]+)->([\d.]+)/);
  const oldPrice = priceMatch ? Number(priceMatch[1]) : null;
  const newPrice = priceMatch ? Number(priceMatch[2]) : Number(v.price);

  return (
    <div className="glass-card overflow-hidden group transition-all hover:border-amber-500/30 border-amber-500/10 flex flex-col">
      {/* Photo thumbnail */}
      {v.photos?.[0] ? (
        <img
          src={v.photos[0]}
          alt={`${v.year} ${v.make} ${v.model}`}
          loading="lazy"
          className="w-full h-40 object-cover bg-surface-900"
        />
      ) : (
        <div className="w-full h-40 bg-surface-900/50 flex flex-col items-center justify-center gap-1">
          <Car size={28} className="text-surface-700" />
          <span className="text-[8px] font-bold text-surface-600 uppercase tracking-widest">No Photo</span>
        </div>
      )}

      <div className="p-5 space-y-4 flex-1 flex flex-col">
        <div>
          <h3 className="text-sm font-black text-white uppercase tracking-wide">
            {v.year} {v.make} {v.model}
          </h3>
          <p className="text-[10px] text-surface-500 font-mono uppercase mt-0.5">
            {v.vin || 'No VIN'}
          </p>
        </div>

        <div className="bg-surface-950/50 rounded-xl p-3 border border-surface-800/50 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-surface-500 uppercase tracking-widest">Inventory Price</span>
            <span className="text-sm font-black text-emerald-400">${newPrice.toLocaleString()}</span>
          </div>
          {oldPrice && (
            <div className="flex items-center justify-between border-t border-surface-800/50 pt-2">
              <span className="text-[10px] font-bold text-surface-500 uppercase tracking-widest">FB Price</span>
              <span className="text-sm font-bold text-surface-500 line-through">${oldPrice.toLocaleString()}</span>
            </div>
          )}
        </div>

        <div className="mt-auto">
          <Badge variant="warning" size="xs" className="mb-3">
            <DollarSign size={8} className="mr-1" />
            Price Changed
          </Badge>

          <button
            onClick={onUpdate}
            disabled={disabled || isUpdating}
            className="w-full py-2.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-black uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-2 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100 shadow-glow-amber"
          >
            {isUpdating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {isUpdating ? 'Starting...' : 'Update on FB'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Reuse StreamingView logic (minimal version)
import { useRef } from 'react';
function StreamingView({ onResult, onCancel }) {
  const canvasRef = useRef(null);
  const frameQueueRef = useRef([]);
  const rafRef = useRef(null);
  const [status, setStatus] = useState('initializing');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const drawLoop = () => {
      if (frameQueueRef.current.length > 0) {
        const frame = frameQueueRef.current[frameQueueRef.current.length - 1];
        frameQueueRef.current = [];
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        img.src = `data:image/jpeg;base64,${frame.data}`;
      }
      rafRef.current = requestAnimationFrame(drawLoop);
    };
    rafRef.current = requestAnimationFrame(drawLoop);

    const unsubFrame = window.autolander.fb.onFrame((frame) => {
      frameQueueRef.current.push(frame);
    });

    const unsubProgress = window.autolander.fb.onProgress((data) => {
      const { stage, message, detail } = data;
      setStatus(stage);
      setMessage(message || '');
      if (stage === 'success') setTimeout(() => onResult(detail || {}), 2000);
      if (stage === 'error' || stage === 'timeout') setTimeout(() => onResult({ error: true, message }), 2000);
    });

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      unsubFrame();
      unsubProgress();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <header className="flex items-center justify-between">
        <h2 className="text-xl font-black text-white uppercase tracking-tight">Updating Listing</h2>
        <button onClick={onCancel} className="text-xs font-bold text-surface-500 hover:text-rose-400 uppercase tracking-widest">Cancel</button>
      </header>
      <div className="glass-card overflow-hidden bg-black aspect-video relative">
        <canvas ref={canvasRef} width={1366} height={768} className="w-full h-full" />
        <div className="absolute bottom-0 left-0 w-full p-4 bg-black/60 backdrop-blur-md border-t border-white/10 flex items-center gap-3">
          <Loader2 size={16} className="animate-spin text-amber-500" />
          <span className="text-[10px] font-black text-white uppercase tracking-[0.2em]">{message || 'AI is updating your listing...'}</span>
        </div>
      </div>
    </div>
  );
}

function ResultView({ data, onBack }) {
  const isError = data?.error;
  return (
    <div className="space-y-8 pb-12 max-w-2xl mx-auto">
      <div className="glass-card p-10 text-center space-y-6">
        {isError ? (
          <>
            <div className="w-20 h-20 mx-auto bg-rose-500/20 border-2 border-rose-500/40 rounded-full flex items-center justify-center shadow-glow-red">
              <AlertCircle size={40} className="text-rose-500" />
            </div>
            <h2 className="text-2xl font-black text-white uppercase">Update Failed</h2>
            <p className="text-surface-400">{data.message || 'Something went wrong.'}</p>
          </>
        ) : (
          <>
            <div className="w-20 h-20 mx-auto bg-emerald-500/20 border-2 border-emerald-500/40 rounded-full flex items-center justify-center shadow-glow-green">
              <CheckCircle2 size={40} className="text-emerald-500" />
            </div>
            <h2 className="text-2xl font-black text-white uppercase">Listing Updated</h2>
            <p className="text-surface-400 font-medium">Facebook Marketplace listing has been synced with your current inventory price.</p>
          </>
        )}
        <button
          onClick={onBack}
          className="flex items-center gap-2 mx-auto px-6 py-2 bg-surface-800 hover:bg-surface-700 text-surface-300 text-xs font-black uppercase tracking-widest rounded-xl transition-all"
        >
          <ArrowLeft size={14} />
          Back to Updates
        </button>
      </div>
    </div>
  );
}
