import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import { AnimatePresence, motion } from 'framer-motion';
import AutoresponderToggle from './AutoresponderToggle';

export default function Layout() {
  const location = useLocation();

  return (
    <div className="flex min-h-screen premium-gradient-bg">
      <Sidebar />
      <main className="flex-1 overflow-x-hidden flex flex-col">
        {/* Global Header/Navbar */}
        <header className="h-14 border-b border-surface-900/50 bg-surface-950/20 backdrop-blur-md flex items-center justify-end px-8 z-40 sticky top-0">
          <div className="flex items-center gap-4">
            <AutoresponderToggle />
          </div>
        </header>

        <div className="p-8 max-w-7xl mx-auto w-full flex-1">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 10, filter: 'blur(8px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -10, filter: 'blur(8px)' }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
