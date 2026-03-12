import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

export default function FilterDropdown({ value, onChange, options, placeholder, label }) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedOption = options.find(opt => opt.value === value) || options[0];

  return (
    <div className="flex flex-col gap-1.5" ref={containerRef}>
      {label && (
        <label className="text-[10px] font-bold uppercase tracking-widest text-surface-500 ml-1">
          {label}
        </label>
      )}
      <div className="relative">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 bg-surface-950/50 border border-surface-800/50 rounded-xl text-sm font-medium transition-all hover:border-surface-700/50 focus:outline-none focus:border-brand-500/50 ${
            isOpen ? 'border-brand-500/50 ring-1 ring-brand-500/20' : ''
          }`}
        >
          <span className={value === 'All' ? 'text-surface-400' : 'text-surface-100'}>
            {selectedOption?.label || placeholder}
          </span>
          <ChevronDown 
            size={14} 
            className={`text-surface-500 transition-transform duration-200 ${isOpen ? 'rotate-180 text-brand-500' : ''}`} 
          />
        </button>

        {isOpen && (
          <div className="absolute z-50 mt-2 w-full min-w-[160px] bg-surface-900 border border-surface-800 rounded-xl shadow-2xl py-2 overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-top">
            <div className="max-h-60 overflow-y-auto scrollbar-thin scrollbar-thumb-surface-700">
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setIsOpen(false);
                  }}
                  className={`w-full text-left px-4 py-2 text-xs font-bold uppercase tracking-widest transition-colors ${
                    option.value === value
                      ? 'bg-brand-500/10 text-brand-400'
                      : 'text-surface-400 hover:bg-surface-800 hover:text-white'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
