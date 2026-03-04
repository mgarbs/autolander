import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import SalesDashboard from './pages/SalesDashboard';
import ManagerDashboard from './pages/ManagerDashboard';
import LeadPipeline from './pages/LeadPipeline';
import LeadDetailPage from './pages/LeadDetailPage';
import Inventory from './pages/Inventory';
import Settings from './pages/Settings';
import FacebookAuth from './pages/FacebookAuth';
import AssistedPost from './pages/AssistedPost';
import Appointments from './pages/Appointments';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen premium-gradient-bg flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

export default function App() {
  const { user } = useAuth();
  const isManager = user?.role === 'MANAGER';

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Navigate to={isManager ? '/manager' : '/sales'} replace />} />
        <Route path="/sales" element={<SalesDashboard />} />
        <Route path="/manager" element={<ManagerDashboard />} />
        <Route path="/leads" element={<LeadPipeline />} />
        <Route path="/leads/:buyerId" element={<LeadDetailPage />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/post" element={<AssistedPost />} />
        <Route path="/appointments" element={<Appointments />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/facebook" element={<FacebookAuth />} />
      </Route>
    </Routes>
  );
}
