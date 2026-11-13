/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        bg: v('bg'),
        surface: v('surface'),
        'surface-2': v('surface-2'),
        border: v('border'),
        ink: v('ink'),
        muted: v('muted'),
        faint: v('faint'),
        primary: { DEFAULT: v('primary'), fg: v('primary-fg'), soft: v('primary-soft') },
        saffron: { DEFAULT: v('saffron'), soft: v('saffron-soft'), ink: v('saffron-ink') },
        good: { DEFAULT: v('good'), soft: v('good-soft') },
        bad: { DEFAULT: v('bad'), soft: v('bad-soft') },
        warn: { DEFAULT: v('warn'), soft: v('warn-soft') },
      },
      borderRadius: { xl: '0.875rem', '2xl': '1.125rem' },
      boxShadow: {
        card: '0 1px 2px rgb(15 23 42 / 0.04), 0 1px 3px rgb(15 23 42 / 0.06)',
        pop: '0 10px 30px -8px rgb(15 23 42 / 0.25), 0 4px 10px -4px rgb(15 23 42 / 0.12)',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0 }, to: { opacity: 1 } },
        'slide-up': { from: { opacity: 0, transform: 'translateY(6px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        'slide-in-right': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        pop: { '0%': { transform: 'scale(.96)', opacity: 0 }, '100%': { transform: 'scale(1)', opacity: 1 } },
        flash: { '0%': { backgroundColor: 'rgb(var(--saffron-soft))' }, '100%': { backgroundColor: 'transparent' } },
      },
      animation: {
        'fade-in': 'fade-in .15s ease-out',
        'slide-up': 'slide-up .18s ease-out',
        'slide-in-right': 'slide-in-right .2s cubic-bezier(.2,.8,.2,1)',
        pop: 'pop .14s ease-out',
        flash: 'flash .9s ease-out',
      },
    },
  },
  plugins: [],
};
