/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#f7f8fa',
          card: '#ffffff',
          hover: '#f0f2f5',
          border: '#e3e7ed',
          deep: '#edf0f4',
        },
        accent: {
          DEFAULT: '#111827',
          hover: '#374151',
          light: '#6b7280',
          muted: '#9ca3af',
          bg: '#f3f4f6',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.035), 0 8px 24px rgba(15, 23, 42, 0.035)',
        'card-hover': '0 2px 4px rgba(15, 23, 42, 0.04), 0 12px 32px rgba(15, 23, 42, 0.07)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
