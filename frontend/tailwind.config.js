/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#f9fafb',
          card: '#ffffff',
          hover: '#f3f4f6',
          border: '#e5e7eb',
          deep: '#f3f4f6',
        },
        accent: {
          DEFAULT: '#111827',
          hover: '#374151',
          light: '#6b7280',
          muted: '#9ca3af',
          bg: '#f3f4f6',
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
