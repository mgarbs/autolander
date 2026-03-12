import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  GitBranch,
  CarFront,
  Send,
  Settings,
  LogOut,
  ChevronRight,
  ShieldCheck,
  Calendar
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useAuth } from '../context/AuthContext';

const navItems = [
  { to: '/sales', label: 'Sales Hub', icon: LayoutDashboard },
  { to: '/manager', label: 'Manager Center', icon: ShieldCheck },
  { to: '/inventory', label: 'Inventory Management', icon: CarFront },
  { to: '/appointments', label: 'Appointments', icon: Calendar },
  { to: '/post', label: 'Post to Market', icon: Send },
  { to: '/settings', label: 'Configuration', icon: Settings },
];

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <nav className="w-64 bg-surface-950/80 backdrop-blur-xl border-r border-surface-900/50 flex flex-col h-screen sticky top-0">
      <div className="p-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center shadow-glow-blue">
            <CarFront className="w-5 h-5 text-white" />
          </div>
          <span className="text-xl font-bold tracking-tight bg-gradient-to-r from-white to-surface-400 bg-clip-text text-transparent">
            AUTOLANDER
          </span>
        </div>
        <div className="px-1">
          <span className="text-[10px] uppercase tracking-[0.2em] font-semibold text-brand-500/80">
            SALES ENGINE
          </span>
        </div>
      </div>

      <div className="flex-1 py-4 px-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname === item.to;

          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `
                group relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-300
                ${isActive
                  ? 'bg-brand-500/10 text-white'
                  : 'text-surface-400 hover:text-surface-100 hover:bg-surface-900/50'}
              `}
            >
              {isActive && (
                <motion.div
                  layoutId="sidebar-active"
                  className="absolute left-0 w-1 h-6 bg-brand-500 rounded-r-full"
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}  
                />
              )}

              <Icon className={`w-5 h-5 transition-transform duration-300 group-hover:scale-110 ${isActive ? 'text-brand-500' : 'text-surface-500 group-hover:text-brand-400'}`} />
              <span className="flex-1">{item.label}</span>

              {isActive && (
                <ChevronRight className="w-4 h-4 text-brand-500/50" />
              )}
            </NavLink>
          );
        })}
      </div>

      <div className="p-4 mt-auto">
        <div className="bg-surface-900/40 rounded-2xl p-4 border border-surface-800/30">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-surface-800 flex items-center justify-center border border-surface-700 overflow-hidden">
               <div className="w-full h-full bg-gradient-to-br from-brand-600 to-brand-900 opacity-80 flex items-center justify-center text-white text-sm font-bold">
                 {user?.displayName?.charAt(0)?.toUpperCase() || '?'}
               </div>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-surface-200 truncate">{user?.displayName || 'User'}</p>
              <p className="text-[10px] text-surface-500 uppercase tracking-wider">{user?.role || 'salesperson'}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 py-2 text-xs font-medium text-surface-400 hover:text-red-400 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
        <div className="mt-4 px-2 flex justify-between items-center text-[10px] text-surface-600 font-mono">
          <span>v0.4.0</span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            SYSTEM ACTIVE
          </span>
        </div>
      </div>
    </nav>
  );
}
