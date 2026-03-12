import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, 
  ShieldCheck, 
  Facebook, 
  Monitor, 
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Lock
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// Must match the Puppeteer viewport in fb-auth-session.js
const VIEWPORT_W = 1366;
const VIEWPORT_H = 768;

// Throttle mousemove events — only send one every N ms
const MOUSEMOVE_THROTTLE_MS = 50;

export default function FacebookAuth() {
  const canvasRef = useRef(null);
  const navigate = useNavigate();

  const [status, setStatus] = useState('connecting'); // connecting | waiting_login | success | error
  const [message, setMessage] = useState('');

  // Use a ref for status inside callbacks so they don't capture stale closures
  const statusRef = useRef('connecting');
  const setStatusBoth = (s) => { statusRef.current = s; setStatus(s); };

  const frameQueueRef = useRef([]);
  const rafRef = useRef(null);
  const lastMouseMoveRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    // RAF draw loop — always draws the latest frame, drops stale ones
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

    // Initialize FB login via IPC
    const startSession = async () => {
      try {
        await window.autolander.fb.login();
      } catch (err) {
        setStatusBoth('error');
        setMessage(err.message || 'Failed to start Facebook session');
      }
    };

    // Set up IPC listeners
    const unlistenFrame = window.autolander.fb.onFrame((frame) => {
      if (frame?.data) {
        frameQueueRef.current.push(frame);
      }
    });

    const unlistenProgress = window.autolander.fb.onProgress((info) => {
      if (info.status) {
        setStatusBoth(info.status);
        if (info.message) setMessage(info.message);
        
        if (info.status === 'success') {
          setTimeout(() => navigate('/settings'), 2500);
        }
      }
    });

    startSession();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (typeof unlistenFrame === 'function') unlistenFrame();
      if (typeof unlistenProgress === 'function') unlistenProgress();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Scale mouse coordinates from canvas display size to Puppeteer viewport space
  const getViewportCoords = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - rect.left) * (VIEWPORT_W / rect.width)),
      y: Math.round((e.clientY - rect.top) * (VIEWPORT_H / rect.height)),
    };
  };

  const send = (event) => {
    window.autolander.fb.sendInput(event);
  };

  const handleMouseMove = (e) => {
    const now = Date.now();
    if (now - lastMouseMoveRef.current < MOUSEMOVE_THROTTLE_MS) return;
    lastMouseMoveRef.current = now;
    const { x, y } = getViewportCoords(e);
    send({ type: 'mousemove', x, y });
  };

  const handleMouseDown = (e) => {
    canvasRef.current.focus();
    const { x, y } = getViewportCoords(e);
    send({ type: 'mousedown', x, y, button: e.button === 2 ? 'right' : 'left' });
    e.preventDefault();
  };

  const handleMouseUp = (e) => {
    const { x, y } = getViewportCoords(e);
    send({ type: 'mouseup', x, y, button: e.button === 2 ? 'right' : 'left' });
  };

  const handleKeyDown = (e) => {
    e.preventDefault();
    send({ type: 'keydown', key: e.key });
  };

  const handleWheel = (e) => {
    e.preventDefault();
    send({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY });
  };

  const statusBar = {
    connecting:    { bg: 'bg-surface-900', text: 'text-surface-400', label: 'INITIALIZING VIRTUAL BROWSER...', icon: RefreshCw, spin: true },
    waiting_login: { bg: 'bg-brand-500/10',  text: 'text-brand-400',  label: 'AUTHENTICATE WITH FACEBOOK — CREDENTIALS ARE ENCRYPTED AT REST', icon: ShieldCheck, spin: false },
    success:       { bg: 'bg-emerald-500/10', text: 'text-emerald-400', label: message || 'SUCCESS — REDIRECTING TO DASHBOARD', icon: CheckCircle2, spin: false },
    error:         { bg: 'bg-rose-500/10',   text: 'text-rose-400',   label: message || 'AUTHENTICATION STREAM INTERRUPTED', icon: AlertCircle, spin: false },
  }[status] ?? { bg: 'bg-surface-900', text: 'text-surface-400', label: '', icon: Monitor, spin: false };

  return (
    <div className="space-y-8 pb-12 max-w-6xl mx-auto">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-brand-500 font-bold text-xs uppercase tracking-widest">
            <Lock size={14} />
            Secure Portal
          </div>
          <h1 className="text-4xl font-black text-white tracking-tight leading-none uppercase">
            Account <span className="text-brand-500">Bridge</span>
          </h1>
          <p className="text-surface-500 font-medium max-w-lg">
            Connect your Facebook account to enable automated inventory distribution and AI responder synchronization.
          </p>
        </div>
        
        <button
          onClick={() => navigate('/settings')}
          className="group flex items-center gap-2 text-xs font-black uppercase tracking-widest text-surface-500 hover:text-brand-400 transition-all"
        >
          <ArrowLeft size={14} />
          Cancel Connection
        </button>
      </header>

      {/* Connection Console */}
      <div className="glass-card overflow-hidden shadow-2xl relative">
        {/* Decorative elements */}
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-brand-500 to-transparent opacity-50" />
        
        {/* Console Header / Status */}
        <div className={`px-6 py-4 flex items-center gap-4 border-b border-surface-900/50 ${statusBar.bg} transition-colors duration-500`}>
          <div className={`p-2 rounded-lg bg-white/5 ${statusBar.text}`}>
            <statusBar.icon size={18} className={statusBar.spin ? 'animate-spin' : ''} />
          </div>
          <span className={`text-[11px] font-black uppercase tracking-[0.15em] ${statusBar.text}`}>
            {statusBar.label}
          </span>
          <div className="ml-auto flex items-center gap-2 px-3 py-1 bg-black/20 rounded-full border border-white/5">
             <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-glow-green" />
             <span className="text-[9px] font-bold text-surface-400 uppercase tracking-widest">Stream Active</span>
          </div>
        </div>

        {/* Browser viewport */}
        <div className="relative bg-[#0d0d0f] aspect-[1366/768] overflow-hidden group">
          <AnimatePresence>
            {status === 'connecting' && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 flex flex-col items-center justify-center z-20 bg-surface-950 gap-4"
              >
                <div className="w-16 h-16 border-4 border-brand-500 border-t-transparent rounded-full animate-spin shadow-glow-blue" />
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-surface-600">Booting Virtual Instance...</span>
              </motion.div>
            )}
            
            {status === 'success' && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="absolute inset-0 flex flex-col items-center justify-center z-20 bg-surface-950/80 backdrop-blur-md gap-4"
              >
                <div className="w-20 h-20 bg-emerald-500/20 border-2 border-emerald-500/40 rounded-full flex items-center justify-center shadow-glow-green">
                  <CheckCircle2 size={40} className="text-emerald-500" />
                </div>
                <h2 className="text-2xl font-black text-white uppercase tracking-tighter italic">Handshake Successful</h2>
                <p className="text-xs text-surface-400 font-bold uppercase tracking-widest">Finalizing secure session storage</p>
              </motion.div>
            )}
          </AnimatePresence>

          <canvas
            ref={canvasRef}
            width={VIEWPORT_W}
            height={VIEWPORT_H}
            tabIndex={0}
            className={`w-full h-full block cursor-default outline-none transition-opacity duration-700 ${status === 'waiting_login' ? 'opacity-100' : 'opacity-40'}`}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onKeyDown={handleKeyDown}
            onWheel={handleWheel}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>

        {/* Console Footer */}
        <div className="p-4 bg-surface-900/50 border-t border-surface-900/50 flex flex-col md:flex-row items-center justify-between gap-4">
           <div className="flex items-center gap-6">
              <div className="flex items-center gap-2 text-[9px] font-bold text-surface-600 uppercase tracking-widest">
                 <Monitor size={12} />
                 Resolution: 1366x768
              </div>
              <div className="flex items-center gap-2 text-[9px] font-bold text-surface-600 uppercase tracking-widest">
                 <Facebook size={12} />
                 Channel: Marketplace
              </div>
           </div>
           
           <div className="text-[9px] font-bold text-surface-500 uppercase tracking-widest italic max-w-sm text-center md:text-right leading-relaxed">
             Interact with the window above. Your login data is transmitted via a secure encrypted bridge and never stored on-disk unencrypted.
           </div>
        </div>
      </div>

      {status === 'error' && (
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex justify-center"
        >
          <button
            onClick={() => window.location.reload()}
            className="flex items-center gap-2 px-8 py-3 bg-brand-500 hover:bg-brand-600 text-white text-xs font-black uppercase tracking-[0.2em] rounded-xl transition-all shadow-glow-blue active:scale-95"
          >
            <RefreshCw size={16} />
            Re-Initialize Stream
          </button>
        </motion.div>
      )}
    </div>
  );
}
