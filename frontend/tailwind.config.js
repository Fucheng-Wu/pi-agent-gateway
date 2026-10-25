/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      fontFamily: { sans: ['var(--font-sans)'] },
      colors: {
        ink: Object.fromEntries([950, 900, 850, 800, 700].map((shade) => [shade, `rgb(var(--ink-${shade}) / <alpha-value>)`])),
        slate: Object.fromEntries([100, 200, 300, 400, 500, 600].map((shade) => [shade, `rgb(var(--slate-${shade}) / <alpha-value>)`])),
        accent: {
          DEFAULT: 'rgb(var(--accent-400) / <alpha-value>)',
          300: 'rgb(var(--accent-300) / <alpha-value>)',
          400: 'rgb(var(--accent-400) / <alpha-value>)',
          500: 'rgb(var(--accent-500) / <alpha-value>)'
        },
        white: 'rgb(var(--white) / <alpha-value>)',
        rose: Object.fromEntries([200, 300, 400, 500].map((shade) => [shade, `rgb(var(--rose-${shade}) / <alpha-value>)`])),
        emerald: Object.fromEntries([200, 300, 400].map((shade) => [shade, `rgb(var(--emerald-${shade}) / <alpha-value>)`])),
        amber: Object.fromEntries([300, 400].map((shade) => [shade, `rgb(var(--amber-${shade}) / <alpha-value>)`]))
      },
      boxShadow: { panel: 'var(--panel-shadow)' }
    }
  },
  plugins: []
}
