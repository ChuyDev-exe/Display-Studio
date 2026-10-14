/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.js'],
  theme: {
    extend: {
      colors: {
        // Grafito neutro: superficies del banco de trabajo, de la más profunda a la más clara.
        ink: {
          950: '#121417',
          900: '#17191d',
          800: '#1d2025',
          700: '#24282e',
          600: '#2c3037',
          500: '#3a3f47',
        },
        // Un único acento para selección, foco y acción principal.
        accent: {
          DEFAULT: '#7aa7ff',
          soft: '#7aa7ff1f',
          strong: '#9dbdff',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['10.5px', '14px'],
      },
    },
  },
  plugins: [],
};
