import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getBaseUrl } from '../api/client';

export const getAccessToken = () => localStorage.getItem('accessToken');
export const getRefreshToken = () => localStorage.getItem('refreshToken');

const setTokens = (accessToken, refreshToken) => {
  if (accessToken) localStorage.setItem('accessToken', accessToken);
  if (refreshToken) localStorage.setItem('refreshToken', refreshToken);
};

const clearTokens = () => {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
};

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const apiFetch = useCallback(async (path, options = {}) => {
    const base = getBaseUrl();
    const token = getAccessToken();
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetch(`${base}${path}`, { ...options, headers });
  }, []);

  const rotateTokens = useCallback(async () => {
    const rToken = getRefreshToken();
    if (!rToken) throw new Error('No refresh token available');

    const response = await apiFetch('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: rToken }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Token rotation failed');

    setTokens(data.accessToken, data.refreshToken);
    return data.accessToken;
  }, [apiFetch]);

  const login = async (username, password) => {
    setError(null);
    const base = getBaseUrl();

    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Login failed');

    setTokens(data.accessToken, data.refreshToken);
    setUser(data.user);

    // Connect agent WS if in Electron
    if (window.autolander?.agent) {
      window.autolander.agent.login({
        serverUrl: base,
        accessToken: data.accessToken,
      }).catch(err => console.warn('[auth] Agent connect failed:', err));
    }

    return data.user;
  };

  const register = async (userData) => {
    setError(null);
    const base = getBaseUrl();

    const response = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Registration failed');
    return data.user;
  };

  const logout = async () => {
    setError(null);
    const rToken = getRefreshToken();
    try {
      if (rToken) {
        await apiFetch('/api/auth/logout', {
          method: 'POST',
          body: JSON.stringify({ refreshToken: rToken }),
        });
      }
    } catch {}

    if (window.autolander?.agent) {
      window.autolander.agent.logout().catch(() => {});
    }

    clearTokens();
    setUser(null);
  };

  useEffect(() => {
    const fetchMe = async (token) => {
      const base = getBaseUrl();
      const res = await fetch(`${base}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.user;
    };

    const initAuth = async () => {
      const token = getAccessToken();
      if (!token && !getRefreshToken()) {
        setLoading(false);
        return;
      }

      try {
        let me = token ? await fetchMe(token) : null;
        if (!me && getRefreshToken()) {
          const newToken = await rotateTokens();
          me = await fetchMe(newToken);
        }
        if (me) {
          setUser(me);
          // Connect agent WS + start inbox polling on session restore
          if (window.autolander?.agent) {
            const base = getBaseUrl();
            const activeToken = getAccessToken();
            window.autolander.agent.login({
              serverUrl: base,
              accessToken: activeToken,
            }).catch(err => console.warn('[auth] Agent connect on restore failed:', err));
          }
        } else clearTokens();
      } catch {
        clearTokens();
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    initAuth();
  }, [rotateTokens]);

  const value = { user, loading, error, login, register, logout, refreshToken: rotateTokens };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}

export default AuthContext;
