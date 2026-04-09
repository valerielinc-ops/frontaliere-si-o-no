/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./App.tsx",
    "./index.tsx",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./services/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        slate: {
          850: '#1e293b',
          950: '#020617',
        },
        // Mediterranean warmth palette
        warm: {
          50:  '#fdf8f4',
          100: '#faeee4',
          200: '#f3daca',
          300: '#e8bfa5',
          400: '#d9a080',
          500: '#c4795a',
          600: '#b0623f',
          700: '#934e32',
          800: '#7a3f2a',
          900: '#653322',
          950: '#3a1b11',
        },
        olive: {
          50:  '#f6f7f0',
          100: '#eaeddb',
          200: '#d5dbb7',
          300: '#b8c48a',
          400: '#9aab63',
          500: '#7d9145',
          600: '#627435',
          700: '#4b592b',
          800: '#3d4726',
          900: '#343d22',
          950: '#1a200f',
        },
      },
      animation: {
        blob: 'blob 7s infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'fade-in-up': 'fadeInUp 0.4s ease-out',
      },
      gridTemplateColumns: {
        '16': 'repeat(16, minmax(0, 1fr))',
        '17': 'repeat(17, minmax(0, 1fr))',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        blob: {
          '0%': {
            transform: 'translate(0px, 0px) scale(1)',
          },
          '33%': {
            transform: 'translate(30px, -50px) scale(1.1)',
          },
          '66%': {
            transform: 'translate(-20px, 20px) scale(0.9)',
          },
          '100%': {
            transform: 'translate(0px, 0px) scale(1)',
          },
        },
      },
    },
  },
  plugins: [],
}
