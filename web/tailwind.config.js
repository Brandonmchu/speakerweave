/** @type {import('tailwindcss').Config} */
import animate from 'tailwindcss-animate'

export default {
  // Raises the specificity of every Tailwind utility so it beats Radix's inline
  // styles. Requires the app to mount inside <div id="root"> and every Radix
  // portal to land inside it too (see ui/dialog, ui/select, ui/dropdown-menu).
  important: '#root',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Explicit breakpoints — same ladder as every-react.
    screens: {
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px',
    },
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'Geist',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '14px' }],
      },
      // Centralized z-index scale for consistent layering.
      zIndex: {
        0: '0',
        10: '10',
        20: '20',
        30: '30',
        40: '40',
        50: '50',
        60: '60',
        70: '70',
        80: '80',
        90: '90',
        100: '100',
        auto: 'auto',
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        placeholder: 'hsl(var(--placeholder-foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          strong: 'hsl(var(--primary-strong))',
          subtle: 'hsl(var(--primary-subtle))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          strong: 'hsl(var(--destructive-strong))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        // Transient row/card highlight (hover + selected) — faint blue so it
        // reads as "interactive" without competing with the primary fill.
        hover: 'hsl(var(--hover))',
        'status-solid': {
          DEFAULT: 'hsl(var(--status-solid))',
          foreground: 'hsl(var(--status-solid-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        navigation: {
          DEFAULT: 'hsl(var(--navigation-background))',
          foreground: 'hsl(var(--navigation-foreground))',
          accent: 'hsl(var(--navigation-accent))',
          'accent-foreground': 'hsl(var(--navigation-accent-foreground))',
          border: 'hsl(var(--navigation-border))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          strong: 'hsl(var(--success-strong))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          strong: 'hsl(var(--warning-strong))',
          foreground: 'hsl(var(--warning-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        soft: 'var(--shadow-soft)',
        raised: 'var(--shadow-raised)',
        lifted: 'var(--shadow-lifted)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [animate],
}
