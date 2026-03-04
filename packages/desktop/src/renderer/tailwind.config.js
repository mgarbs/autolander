/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx}'
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0f4ff',
          100: '#e0e9ff',
          200: '#c1d3ff',
          300: '#a2bdff',
          400: '#6491ff',
          500: '#2665ff',
          600: '#225be6',
          700: '#1d4ca1',
          800: '#173d80',
          900: '#133269',
          950: '#0b1d3d',
        },
        surface: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#d4d4d4',
          400: '#a3a3a3',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#262626',
          900: '#171717',
          950: '#0a0a0c',
        }
      },
      backgroundImage: {
        'glass-gradient': 'linear-gradient(135deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.01) 100%)',
        'glow-gradient': 'radial-gradient(circle at center, var(--tw-gradient-from) 0%, transparent 70%)',
      },
      boxShadow: {
        'glow-blue': '0 0 20px -5px rgba(38, 101, 255, 0.3)',
        'glow-red': '0 0 20px -5px rgba(239, 68, 68, 0.3)',
        'glow-green': '0 0 20px -5px rgba(16, 185, 129, 0.3)',
        'glow-amber': '0 0 20px -5px rgba(245, 158, 11, 0.3)',
        'glass': '0 8px 32px 0 rgba(0, 0, 0, 0.37)',
      }
    }
  },
  plugins: []
};
