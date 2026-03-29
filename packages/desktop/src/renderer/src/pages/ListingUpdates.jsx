import { useEffect, useState, useRef } from 'react';
import { getStaleListings, markVehicleUpdated } from '../api/client';
import Badge from '../components/Badge';
import {
  RefreshCw,
  AlertCircle,
  Car,
  ImageIcon,
  Loader2,
  CheckCircle2,
  ArrowLeft,
  DollarSign,
  MousePointerClick,
  XCircle,
  Monitor,
  Send
} from 'lucide-react';

const VIEWPORT_W = 1366;
const VIEWPORT_H = 768;
const MOUSEMOVE_THROTTLE_MS = 50;

// States where the user can interact with the canvas
const INTERACTIVE_STATES = ['awaiting_publish'];

// States where the AI is working (user watches)
const WORKING_STATES = ['initializing', 'navigating', 'filling_form'];

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
      const result = await getStaleListings();
      setVehicles(result.vehicles || []);
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

// ---------------------------------------------------------------------------
// Streaming View (canvas + IPC)
// ---------------------------------------------------------------------------
function StreamingView({ onResult, onCancel }) {
  const canvasRef = useRef(null);
  const frameQueueRef = useRef([]);
  const rafRef = useRef(null);
  const lastMouseMoveRef = useRef(0);

  const [status, setStatus] = useState('initializing');
  const [message, setMessage] = useState('');
  const [dismissedOverlay, setDismissedOverlay] = useState(false);

  const statusRef = useRef('initializing');
  const setStatusBoth = (s) => { statusRef.current = s; setStatus(s); };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    // RAF draw loop
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

    // Frame Listener
    const unsubFrame = window.autolander.fb.onFrame((frame) => {
      frameQueueRef.current.push(frame);
    });

    // Progress Listener
    const unsubProgress = window.autolander.fb.onProgress((data) => {
      const { stage, message, detail, percent } = data;
      setStatusBoth(stage);
      setMessage(message || '');

      if (stage === 'success') {
        setTimeout(() => onResult(detail || {}), 2500);
      }
      if (stage === 'error' || stage === 'timeout') {
        setTimeout(() => onResult({ error: true, message: message }), 2500);
      }
    });

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      unsubFrame();
      unsubProgress();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const getViewportCoords = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - rect.left) * (VIEWPORT_W / rect.width)),
      y: Math.round((e.clientY - rect.top) * (VIEWPORT_H / rect.height)),
    };
  };

  const send = (inputData) => {
    // Flatten { type:'mouse', event:'click', x, y } → { type:'click', x, y }
    // and route to the assisted post session (not auth).
    const { event, type: _cat, ...rest } = inputData;
    window.autolander.fb.sendInput({ input: { type: event, ...rest }, target: 'assisted' });
  };

  const isInteractive = INTERACTIVE_STATES.includes(status);

  const handleMouseMove = (e) => {
    if (!isInteractive) return;
    const now = Date.now();
    if (now - lastMouseMoveRef.current < MOUSEMOVE_THROTTLE_MS) return;
    lastMouseMoveRef.current = now;
    const { x, y } = getViewportCoords(e);
    send({ type: 'mouse', event: 'mousemove', x, y });
  };

  const handleMouseDown = (e) => {
    if (!isInteractive) return;
    canvasRef.current.focus();
    e.preventDefault();
    const { x, y } = getViewportCoords(e);
    send({ type: 'mouse', event: 'mousedown', x, y, button: e.button === 2 ? 'right' : 'left' });
  };

  const handleMouseUp = (e) => {
    if (!isInteractive) return;
    const { x, y } = getViewportCoords(e);
    send({ type: 'mouse', event: 'mouseup', x, y, button: e.button === 2 ? 'right' : 'left' });
  };

  const handleKeyDown = (e) => {
    if (!isInteractive) return;
    e.preventDefault();
    send({ type: 'keyboard', event: 'keydown', key: e.key, code: e.code });
  };

  const handleWheel = (e) => {
    if (!isInteractive) return;
    e.preventDefault();
    send({ type: 'mouse', event: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY });
  };

  const handleCancel = async () => {
    try { await window.autolander.fb.cancelAssistedPost(); } catch (_) {}
    onCancel();
  };

  const statusConfig = {
    connecting:       { bg: 'bg-surface-900',       text: 'text-surface-400',  icon: RefreshCw,        spin: true,  label: 'Connecting...' },
    initializing:     { bg: 'bg-surface-900',       text: 'text-surface-400',  icon: Loader2,          spin: true,  label: 'Launching browser...' },
    navigating:       { bg: 'bg-surface-900',       text: 'text-surface-400',  icon: Loader2,          spin: true,  label: 'Opening Marketplace...' },
    filling_form:     { bg: 'bg-amber-500/10',      text: 'text-amber-400',    icon: Loader2,          spin: true,  label: 'AI is updating your listing...' },
    awaiting_publish: { bg: 'bg-emerald-500/10',    text: 'text-emerald-400',  icon: MousePointerClick, spin: false, label: 'Review changes and click Save' },
    success:          { bg: 'bg-emerald-500/10',    text: 'text-emerald-400',  icon: CheckCircle2,     spin: false, label: message || 'Updated!' },
    error:            { bg: 'bg-rose-500/10',       text: 'text-rose-400',     icon: AlertCircle,      spin: false, label: message || 'Something went wrong' },
    timeout:          { bg: 'bg-amber-500/10',      text: 'text-amber-400',    icon: AlertCircle,      spin: false, label: message || 'Session timed out' },
  }[status] || { bg: 'bg-surface-900', text: 'text-surface-400', icon: Monitor, spin: false, label: '' };

  const StatusIcon = statusConfig.icon;

  return (
    <div className="space-y-6 pb-12 max-w-6xl mx-auto">
      <header className="flex items-end justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-amber-500 font-bold text-xs uppercase tracking-widest">
            <RefreshCw size={14} />
            Updating Listing
          </div>
          <h1 className="text-3xl font-black text-white tracking-tight leading-none uppercase">
            {WORKING_STATES.includes(status)
              ? <>AI <span className="text-amber-500">Working</span></>
              : <>Your <span className="text-emerald-400">Turn</span></>
            }
          </h1>
        </div>
        <button
          onClick={handleCancel}
          className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-surface-500 hover:text-rose-400 transition-all"
        >
          <XCircle size={14} />
          Cancel
        </button>
      </header>

      <div className="glass-card overflow-hidden shadow-2xl relative">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-amber-500 to-transparent opacity-50" />

        {/* Status bar */}
        <div className={`px-6 py-4 flex items-center gap-4 border-b border-surface-900/50 ${statusConfig.bg} transition-colors duration-500`}>
          <div className={`p-2 rounded-lg bg-white/5 ${statusConfig.text}`}>
            <StatusIcon size={18} className={statusConfig.spin ? 'animate-spin' : ''} />
          </div>
          <span className={`text-[11px] font-black uppercase tracking-[0.15em] ${statusConfig.text}`}>
            {statusConfig.label}
          </span>
          <div className="ml-auto flex items-center gap-2 px-3 py-1 bg-black/20 rounded-full border border-white/5">
            <div className={`w-1.5 h-1.5 rounded-full ${isInteractive ? 'bg-emerald-500 animate-pulse shadow-glow-green' : 'bg-amber-500'}`} />
            <span className="text-[9px] font-bold text-surface-400 uppercase tracking-widest">
              {isInteractive ? 'Interactive' : 'AI Working'}
            </span>
          </div>
        </div>

        {/* Canvas */}
        <div className="relative bg-[#0d0d0f] aspect-[1366/768] overflow-hidden">
          {/* Instruction overlay for awaiting_publish */}
          {status === 'awaiting_publish' && !dismissedOverlay && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-20 bg-surface-950/80 backdrop-blur-md gap-6">
              <div className="w-20 h-20 bg-emerald-500/20 border-2 border-emerald-500/40 rounded-full flex items-center justify-center shadow-glow-green">
                <MousePointerClick size={40} className="text-emerald-500" />
              </div>
              <h2 className="text-2xl font-black text-white uppercase tracking-tight">Review Updates</h2>
              <div className="text-sm text-surface-300 text-center max-w-md space-y-2">
                <p>The AI has updated the price and details. Now it's your turn:</p>
                <ol className="text-left text-surface-400 space-y-1 pl-4">
                  <li>1. Review the changes and click <strong className="text-white">"Save"</strong></li>
                  <li>2. Or click <strong className="text-white">"Update Listing"</strong> if prompted</li>
                </ol>
              </div>
              <button
                onClick={() => setDismissedOverlay(true)}
                className="px-8 py-3 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black uppercase tracking-[0.2em] rounded-xl transition-all active:scale-95"
              >
                Got it — I'll take over
              </button>
            </div>
          )}

          <canvas
            ref={canvasRef}
            width={VIEWPORT_W}
            height={VIEWPORT_H}
            tabIndex={0}
            className={`w-full h-full block outline-none transition-opacity duration-500 ${
              isInteractive && dismissedOverlay ? 'opacity-100 cursor-default' : 'opacity-60 cursor-wait'
            }`}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onKeyDown={handleKeyDown}
            onWheel={handleWheel}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>

        {/* Footer */}
        <div className="p-4 bg-surface-900/50 border-t border-surface-900/50 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-[9px] font-bold text-surface-600 uppercase tracking-widest">
              <Monitor size={12} /> 1366x768
            </div>
          </div>
          <div className="text-[9px] font-bold text-surface-500 uppercase tracking-widest italic max-w-sm text-right leading-relaxed">
            {isInteractive
              ? 'You have full control. Your clicks go directly to the browser.'
              : 'AI is updating the listing. You will take over for the final save.'}
          </div>
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
