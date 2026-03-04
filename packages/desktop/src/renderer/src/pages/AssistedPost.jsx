import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getInventory, startAssistedPost, cancelPostSession } from '../api/client';
import {
  Send,
  ArrowLeft,
  Monitor,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  XCircle,
  ImageIcon,
  Car,
  MousePointerClick,
  Loader2,
  Search,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

const VIEWPORT_W = 1366;
const VIEWPORT_H = 768;
const MOUSEMOVE_THROTTLE_MS = 50;

// States where the user can interact with the canvas
const INTERACTIVE_STATES = ['awaiting_review', 'awaiting_publish'];

// States where the AI is working (user watches)
const WORKING_STATES = ['initializing', 'navigating', 'uploading_photos', 'filling_form'];

export default function AssistedPost() {
  const [phase, setPhase] = useState('select'); // select | streaming | result
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedVin, setSelectedVin] = useState(null);
  const [startingVin, setStartingVin] = useState(null);
  const [resultData, setResultData] = useState(null);

  useEffect(() => {
    getInventory()
      .then(data => setVehicles(data.vehicles || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleStartPost = async (vehicle) => {
    if (startingVin) return;
    setStartingVin(vehicle.vin);
    try {
      await startAssistedPost(vehicle.vin);
      setSelectedVin(vehicle.vin);
      setPhase('streaming');
    } catch (e) {
      alert(e.message || 'Failed to start posting session');
      setStartingVin(null);
    }
  };

  const handleResult = (data) => {
    setResultData(data);
    setPhase('result');
  };

  const handleBack = () => {
    setPhase('select');
    setSelectedVin(null);
    setStartingVin(null);
    setResultData(null);
  };

  if (phase === 'streaming') {
    return <StreamingView onResult={handleResult} onCancel={handleBack} />;
  }

  if (phase === 'result') {
    return <ResultView data={resultData} onBack={handleBack} />;
  }

  return <VehicleSelector vehicles={vehicles} loading={loading} onSelect={handleStartPost} startingVin={startingVin} />;
}

// ---------------------------------------------------------------------------
// Vehicle Selector
// ---------------------------------------------------------------------------
const PER_PAGE = 12;

function VehicleCard({ v, onSelect, variant = 'default', isStarting = false, disableActions = false }) {
  const isStale = variant === 'stale';
  const disabled = disableActions || isStarting;
  return (
    <div className={`glass-card overflow-hidden group transition-all ${isStale ? 'hover:border-amber-500/30 border-amber-500/10' : 'hover:border-brand-500/30'}`}>
      {/* Photo thumbnail */}
      {v.photos?.[0] ? (
        <img
          src={v.photos[0]}
          alt={`${v.year} ${v.make} ${v.model}`}
          loading="lazy"
          className="w-full h-40 object-cover bg-surface-900"
        />
      ) : (
        <div className="w-full h-40 bg-surface-900/50 flex items-center justify-center">
          <Car size={32} className="text-surface-700" />
        </div>
      )}

      <div className="p-5 space-y-3">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-black text-white uppercase tracking-wide">
              {v.year} {v.make} {v.model}
            </h3>
            <p className="text-[10px] text-surface-500 font-mono uppercase mt-0.5">
              {v.vin || 'No VIN'}
            </p>
          </div>
          {v.price && (
            <span className="text-sm font-black text-brand-400">
              ${Number(v.price).toLocaleString()}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 text-[10px] text-surface-500 uppercase tracking-widest font-bold">
          {v.mileage && <span>{Number(v.mileage).toLocaleString()} mi</span>}
          {v.body_style && <span>{v.body_style}</span>}
          {v.photos?.length > 0 && (
            <span className="flex items-center gap-1">
              <ImageIcon size={10} />
              {v.photos.length}
            </span>
          )}
        </div>

        <button
          onClick={() => onSelect(v)}
          disabled={disabled}
          className={`w-full mt-2 py-2.5 text-white text-xs font-black uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-2 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100 ${
            isStale
              ? 'bg-amber-500 hover:bg-amber-600'
              : 'bg-brand-500 hover:bg-brand-600 shadow-glow-blue'
          }`}
        >
          {isStarting ? <Loader2 size={14} className="animate-spin" /> : (isStale ? <RefreshCw size={14} /> : <Send size={14} />)}
          {isStarting ? 'Starting...' : (isStale ? 'Re-Post with Updates' : 'Post to Marketplace')}
        </button>
      </div>
    </div>
  );
}

function VehicleSelector({ vehicles, loading, onSelect, startingVin = null }) {
  const [search, setSearch] = useState('');
  const [filterMake, setFilterMake] = useState('All');
  const [filterBody, setFilterBody] = useState('All');
  const [sortBy, setSortBy] = useState('price-asc');
  const [page, setPage] = useState(1);

  const available = vehicles.filter(v =>
    !v.listings?.facebook_marketplace?.posted
  );
  const stale = vehicles.filter(v =>
    v.listings?.facebook_marketplace?.posted &&
    v.listings?.facebook_marketplace?.stale
  );

  // Unique makes and body styles for filter dropdowns
  const makes = [...new Set(available.map(v => v.make).filter(Boolean))].sort();
  const bodyStyles = [...new Set(available.map(v => v.body_style).filter(Boolean))].sort();

  // Filter + sort + paginate
  let filtered = available;

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(v =>
      `${v.year} ${v.make} ${v.model}`.toLowerCase().includes(q)
    );
  }
  if (filterMake !== 'All') {
    filtered = filtered.filter(v => v.make === filterMake);
  }
  if (filterBody !== 'All') {
    filtered = filtered.filter(v => v.body_style === filterBody);
  }

  filtered.sort((a, b) => {
    switch (sortBy) {
      case 'price-asc':  return (Number(a.price) || 0) - (Number(b.price) || 0);
      case 'price-desc': return (Number(b.price) || 0) - (Number(a.price) || 0);
      case 'year-desc':  return (Number(b.year) || 0) - (Number(a.year) || 0);
      case 'year-asc':   return (Number(a.year) || 0) - (Number(b.year) || 0);
      case 'newest':     return new Date(b.meta?.created_at || 0) - new Date(a.meta?.created_at || 0);
      default: return 0;
    }
  });

  const totalFiltered = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  // Reset page when filters change
  const handleSearch = (val) => { setSearch(val); setPage(1); };
  const handleMake = (val) => { setFilterMake(val); setPage(1); };
  const handleBody = (val) => { setFilterBody(val); setPage(1); };
  const handleSort = (val) => { setSortBy(val); setPage(1); };

  // Page numbers to show
  const pageNumbers = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= safePage - 1 && i <= safePage + 1)) {
      pageNumbers.push(i);
    } else if (pageNumbers[pageNumbers.length - 1] !== '...') {
      pageNumbers.push('...');
    }
  }

  return (
    <div className="space-y-8 pb-12 max-w-6xl">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-brand-500 font-bold text-xs uppercase tracking-widest">
          <Send size={14} />
          Assisted Posting
        </div>
        <h1 className="text-4xl font-black text-white tracking-tight leading-none uppercase">
          Post to <span className="text-brand-500">Marketplace</span>
        </h1>
        <p className="text-surface-500 font-medium max-w-lg">
          AI fills the form, you click publish. Select a vehicle to begin.
        </p>
      </header>

      {loading ? (
        <div className="flex items-center justify-center py-20 opacity-30">
          <RefreshCw size={24} className="animate-spin" />
        </div>
      ) : available.length === 0 && stale.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <Car size={40} className="mx-auto mb-4 text-surface-600" />
          <p className="text-surface-400 font-medium">No vehicles available to post.</p>
          <p className="text-surface-600 text-sm mt-1">Add inventory or check if vehicles are already listed.</p>
        </div>
      ) : (
        <>
          {/* Stale listings — dealer updated data since last FB post */}
          {stale.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <AlertCircle size={14} className="text-amber-400" />
                <h2 className="text-xs font-black uppercase tracking-widest text-amber-400">
                  Updated Since Posted ({stale.length})
                </h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {stale.map(v => (
                  <VehicleCard
                    key={v.vin}
                    v={v}
                    onSelect={onSelect}
                    variant="stale"
                    isStarting={startingVin === v.vin}
                    disableActions={!!startingVin && startingVin !== v.vin}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Toolbar: search, filters, sort */}
          {available.length > 0 && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row gap-3">
                {/* Search */}
                <div className="relative flex-1">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500 pointer-events-none" />
                  <input
                    type="text"
                    value={search}
                    onChange={e => handleSearch(e.target.value)}
                    placeholder="Search vehicles..."
                    className="w-full pl-10 pr-4 py-2.5 bg-surface-950/50 border border-surface-800/50 rounded-xl text-sm text-white placeholder-surface-600 outline-none focus:border-brand-500/50 transition-colors"
                  />
                </div>

                {/* Make filter */}
                <select
                  value={filterMake}
                  onChange={e => handleMake(e.target.value)}
                  className="px-4 py-2.5 bg-surface-950/50 border border-surface-800/50 rounded-xl text-sm text-white outline-none focus:border-brand-500/50 transition-colors appearance-none cursor-pointer"
                >
                  <option value="All">All Makes</option>
                  {makes.map(m => <option key={m} value={m}>{m}</option>)}
                </select>

                {/* Body type filter */}
                <select
                  value={filterBody}
                  onChange={e => handleBody(e.target.value)}
                  className="px-4 py-2.5 bg-surface-950/50 border border-surface-800/50 rounded-xl text-sm text-white outline-none focus:border-brand-500/50 transition-colors appearance-none cursor-pointer"
                >
                  <option value="All">All Body Types</option>
                  {bodyStyles.map(b => <option key={b} value={b}>{b}</option>)}
                </select>

                {/* Sort */}
                <select
                  value={sortBy}
                  onChange={e => handleSort(e.target.value)}
                  className="px-4 py-2.5 bg-surface-950/50 border border-surface-800/50 rounded-xl text-sm text-white outline-none focus:border-brand-500/50 transition-colors appearance-none cursor-pointer"
                >
                  <option value="price-asc">Price: Low → High</option>
                  <option value="price-desc">Price: High → Low</option>
                  <option value="year-desc">Year: Newest</option>
                  <option value="year-asc">Year: Oldest</option>
                  <option value="newest">Recently Added</option>
                </select>
              </div>

              {/* Results count */}
              <p className="text-[10px] font-bold text-surface-500 uppercase tracking-widest">
                Showing {totalFiltered === 0 ? 0 : (safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, totalFiltered)} of {totalFiltered} vehicles
              </p>
            </div>
          )}

          {/* Vehicle grid */}
          {paginated.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {paginated.map(v => (
                <VehicleCard
                  key={v.vin}
                  v={v}
                  onSelect={onSelect}
                  isStarting={startingVin === v.vin}
                  disableActions={!!startingVin && startingVin !== v.vin}
                />
              ))}
            </div>
          )}

          {/* No results from filters */}
          {available.length > 0 && totalFiltered === 0 && (
            <div className="glass-card p-12 text-center">
              <Search size={32} className="mx-auto mb-4 text-surface-600" />
              <p className="text-surface-400 font-medium">No vehicles match your filters.</p>
              <p className="text-surface-600 text-sm mt-1">Try adjusting your search or filter criteria.</p>
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={safePage === 1}
                className="flex items-center gap-1 px-3 py-2 bg-surface-950/50 border border-surface-800/50 rounded-xl text-xs font-black uppercase tracking-widest text-surface-400 hover:text-white hover:border-brand-500/50 transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-surface-400 disabled:hover:border-surface-800/50"
              >
                <ChevronLeft size={14} />
                Prev
              </button>

              {pageNumbers.map((n, i) =>
                n === '...' ? (
                  <span key={`ellipsis-${i}`} className="px-2 text-surface-600 text-xs">...</span>
                ) : (
                  <button
                    key={n}
                    onClick={() => setPage(n)}
                    className={`w-9 h-9 rounded-xl text-xs font-black uppercase transition-all ${
                      n === safePage
                        ? 'bg-brand-500 text-white shadow-glow-blue'
                        : 'bg-surface-950/50 border border-surface-800/50 text-surface-400 hover:text-white hover:border-brand-500/50'
                    }`}
                  >
                    {n}
                  </button>
                )
              )}

              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={safePage === totalPages}
                className="flex items-center gap-1 px-3 py-2 bg-surface-950/50 border border-surface-800/50 rounded-xl text-xs font-black uppercase tracking-widest text-surface-400 hover:text-white hover:border-brand-500/50 transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-surface-400 disabled:hover:border-surface-800/50"
              >
                Next
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Streaming View (canvas + WebSocket)
// ---------------------------------------------------------------------------
function StreamingView({ onResult, onCancel }) {
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const frameQueueRef = useRef([]);
  const rafRef = useRef(null);
  const lastMouseMoveRef = useRef(0);

  const [status, setStatus] = useState('connecting');
  const [message, setMessage] = useState('');
  const [dismissedOverlay, setDismissedOverlay] = useState(false);

  const statusRef = useRef('connecting');
  const setStatusBoth = (s) => { statusRef.current = s; setStatus(s); };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    // RAF draw loop
    const drawLoop = () => {
      if (frameQueueRef.current.length > 0) {
        const base64 = frameQueueRef.current[frameQueueRef.current.length - 1];
        frameQueueRef.current = [];
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        img.src = `data:image/jpeg;base64,${base64}`;
      }
      rafRef.current = requestAnimationFrame(drawLoop);
    };
    rafRef.current = requestAnimationFrame(drawLoop);

    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const accessToken = localStorage.getItem('accessToken');
    const tokenParam = accessToken ? `?token=${encodeURIComponent(accessToken)}` : '';
    const ws = new WebSocket(`${wsProtocol}//${location.host}/assisted-post/stream${tokenParam}`);
    wsRef.current = ws;

    ws.onopen = () => setStatusBoth('initializing');

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'frame') {
          frameQueueRef.current.push(msg.data);
        } else if (msg.type === 'status') {
          setStatusBoth(msg.state);
          setMessage(msg.message || '');
          if (msg.state === 'success') {
            setTimeout(() => onResult(msg.detail || {}), 2500);
          }
          if (msg.state === 'error' || msg.state === 'timeout') {
            setTimeout(() => onResult({ error: true, message: msg.message }), 2500);
          }
        }
      } catch (_) {}
    };

    ws.onerror = () => {
      setStatusBoth('error');
      setMessage('Could not connect to posting stream.');
    };

    ws.onclose = () => {
      if (!['success', 'error', 'timeout'].includes(statusRef.current)) {
        setStatusBoth('error');
        setMessage('Connection closed unexpectedly.');
      }
    };

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ws.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const getViewportCoords = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - rect.left) * (VIEWPORT_W / rect.width)),
      y: Math.round((e.clientY - rect.top) * (VIEWPORT_H / rect.height)),
    };
  };

  const send = (event) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event));
    }
  };

  const isInteractive = INTERACTIVE_STATES.includes(status);

  const handleMouseMove = (e) => {
    if (!isInteractive) return;
    const now = Date.now();
    if (now - lastMouseMoveRef.current < MOUSEMOVE_THROTTLE_MS) return;
    lastMouseMoveRef.current = now;
    const { x, y } = getViewportCoords(e);
    send({ type: 'mousemove', x, y });
  };

  const handleMouseDown = (e) => {
    if (!isInteractive) return;
    canvasRef.current.focus();
    e.preventDefault();
  };

  const handleMouseUp = (e) => {
    if (!isInteractive) return;
    const { x, y } = getViewportCoords(e);
    // Send atomic click — more reliable than split mousedown/mouseup for
    // Facebook's React event system, and avoids async race conditions.
    send({ type: 'click', x, y, button: e.button === 2 ? 'right' : 'left' });
  };

  const handleKeyDown = (e) => {
    if (!isInteractive) return;
    e.preventDefault();
    send({ type: 'keydown', key: e.key });
  };

  const handleWheel = (e) => {
    if (!isInteractive) return;
    e.preventDefault();
    send({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY });
  };

  const handleCancel = async () => {
    try { await cancelPostSession(); } catch (_) {}
    onCancel();
  };

  const statusConfig = {
    connecting:       { bg: 'bg-surface-900',       text: 'text-surface-400',  icon: RefreshCw,        spin: true,  label: 'Connecting...' },
    initializing:     { bg: 'bg-surface-900',       text: 'text-surface-400',  icon: Loader2,          spin: true,  label: 'Launching browser...' },
    navigating:       { bg: 'bg-surface-900',       text: 'text-surface-400',  icon: Loader2,          spin: true,  label: 'Opening Marketplace...' },
    uploading_photos: { bg: 'bg-surface-900',       text: 'text-surface-400',  icon: ImageIcon,        spin: false, label: message || 'Uploading photos...' },
    filling_form:     { bg: 'bg-brand-500/10',      text: 'text-brand-400',    icon: Loader2,          spin: true,  label: 'AI is filling form details...' },
    awaiting_review:  { bg: 'bg-emerald-500/10',    text: 'text-emerald-400',  icon: MousePointerClick, spin: false, label: 'YOUR TURN — Review and click "Next"' },
    awaiting_publish: { bg: 'bg-emerald-500/10',    text: 'text-emerald-400',  icon: MousePointerClick, spin: false, label: 'Click "Publish" to go live!' },
    success:          { bg: 'bg-emerald-500/10',    text: 'text-emerald-400',  icon: CheckCircle2,     spin: false, label: message || 'Published!' },
    error:            { bg: 'bg-rose-500/10',       text: 'text-rose-400',     icon: AlertCircle,      spin: false, label: message || 'Something went wrong' },
    timeout:          { bg: 'bg-amber-500/10',      text: 'text-amber-400',    icon: AlertCircle,      spin: false, label: message || 'Session timed out' },
  }[status] || { bg: 'bg-surface-900', text: 'text-surface-400', icon: Monitor, spin: false, label: '' };

  const StatusIcon = statusConfig.icon;

  return (
    <div className="space-y-6 pb-12 max-w-6xl mx-auto">
      <header className="flex items-end justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-brand-500 font-bold text-xs uppercase tracking-widest">
            <Send size={14} />
            Assisted Posting
          </div>
          <h1 className="text-3xl font-black text-white tracking-tight leading-none uppercase">
            {WORKING_STATES.includes(status)
              ? <>AI <span className="text-brand-500">Working</span></>
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
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-brand-500 to-transparent opacity-50" />

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
          {/* Instruction overlay for awaiting_review */}
          {status === 'awaiting_review' && !dismissedOverlay && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-20 bg-surface-950/80 backdrop-blur-md gap-6">
              <div className="w-20 h-20 bg-emerald-500/20 border-2 border-emerald-500/40 rounded-full flex items-center justify-center shadow-glow-green">
                <MousePointerClick size={40} className="text-emerald-500" />
              </div>
              <h2 className="text-2xl font-black text-white uppercase tracking-tight">Form Complete</h2>
              <div className="text-sm text-surface-300 text-center max-w-md space-y-2">
                <p>The AI has filled all vehicle details. Now it's your turn:</p>
                <ol className="text-left text-surface-400 space-y-1 pl-4">
                  <li>1. Scroll through and review the fields</li>
                  <li>2. Make any corrections if needed</li>
                  <li>3. Click <strong className="text-white">"Next"</strong> at the bottom</li>
                  <li>4. Review the preview, then click <strong className="text-white">"Publish"</strong></li>
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

          {/* AI working overlay */}
          {WORKING_STATES.includes(status) && (
            <div className="absolute top-4 left-4 z-20 px-4 py-2 bg-surface-950/80 backdrop-blur-md rounded-xl border border-brand-500/20 flex items-center gap-3">
              <Loader2 size={14} className="animate-spin text-brand-400" />
              <span className="text-[10px] font-black uppercase tracking-widest text-brand-400">
                AI is working — please wait
              </span>
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
              : 'AI is automating the form. You will take over for the final steps.'}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result View
// ---------------------------------------------------------------------------
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
            <h2 className="text-2xl font-black text-white uppercase">Posting Failed</h2>
            <p className="text-surface-400">{data.message || 'Something went wrong.'}</p>
          </>
        ) : (
          <>
            <div className="w-20 h-20 mx-auto bg-emerald-500/20 border-2 border-emerald-500/40 rounded-full flex items-center justify-center shadow-glow-green">
              <CheckCircle2 size={40} className="text-emerald-500" />
            </div>
            <h2 className="text-2xl font-black text-white uppercase">Listed Successfully</h2>
            {data.postUrl && (
              <a
                href={data.postUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-black uppercase tracking-widest rounded-xl transition-all"
              >
                View Listing on Facebook
              </a>
            )}
          </>
        )}

        <button
          onClick={onBack}
          className="flex items-center gap-2 mx-auto px-6 py-2 bg-surface-800 hover:bg-surface-700 text-surface-300 text-xs font-black uppercase tracking-widest rounded-xl transition-all"
        >
          <ArrowLeft size={14} />
          {isError ? 'Try Again' : 'Post Another'}
        </button>
      </div>
    </div>
  );
}
