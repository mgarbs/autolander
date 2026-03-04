import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const [mode, setMode] = useState('login');
  const [serverUrl, setServerUrl] = useState(
    localStorage.getItem('serverUrl') || 'http://localhost:3000'
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { login, register } = useAuth();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(serverUrl, username, password);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await register(serverUrl, { username, password, displayName, orgName });
      await login(serverUrl, username, password);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen premium-gradient-bg flex items-center justify-center p-4">
      <div className="glass-card p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">AutoLander</h1>
          <p className="text-surface-400 mt-2">
            {mode === 'login' ? 'Sign in to your account' : 'Create your dealership'}
          </p>
        </div>

        <form onSubmit={mode === 'login' ? handleLogin : handleRegister} className="space-y-4">
          <div>
            <label className="block text-sm text-surface-400 mb-1">Server URL</label>
            <input
              type="url"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              className="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-brand-500"
              placeholder="https://your-cloud.onrender.com"
            />
          </div>

          <div>
            <label className="block text-sm text-surface-400 mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-brand-500"
              placeholder="your_username"
              required
            />
          </div>

          <div>
            <label className="block text-sm text-surface-400 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-brand-500"
              placeholder="••••••••"
              required
              minLength={8}
            />
          </div>

          {mode === 'register' && (
            <>
              <div>
                <label className="block text-sm text-surface-400 mb-1">Your Name</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-brand-500"
                  placeholder="John Smith"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-surface-400 mb-1">Dealership Name</label>
                <input
                  type="text"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  className="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-brand-500"
                  placeholder="Smith Auto Sales"
                />
              </div>
            </>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brand-500 hover:bg-brand-600 text-white font-medium py-2.5 rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
            className="text-brand-400 hover:text-brand-300 text-sm"
          >
            {mode === 'login' ? "Don't have an account? Register" : 'Already have an account? Sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}
