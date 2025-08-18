/** Tailwind config for DAOwyn — extended dark theme tokens. */

module.exports = {
  content: [
    './src/app/**/*.{js,ts,jsx,tsx}',
    './src/components/**/*.{js,ts,jsx,tsx}',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'dark-bg': 'var(--bg-base)',
        'dark-bg-contrast': 'var(--bg-contrast)',
        'dark-panel': 'var(--panel)',
        'dark-card': 'var(--card)',
        'dark-card-border': 'var(--card-border)',
        'dark-text': 'var(--text)',
        'dark-muted': 'var(--muted)',
        'accent-green': 'var(--accent-green)',
        'accent-gold': 'var(--accent-gold)',
        'accent-green-strong': 'var(--accent-green-strong)',
        'accent-gold-strong': 'var(--accent-gold-strong)',
      },
      boxShadow: {
        'dark-card': 'var(--card-shadow)',
        'dark-panel': '0 10px 32px rgba(2,6,23,0.22)',
        'glow-accent': '0 8px 30px rgba(31,166,122,0.10)',
      },
      backgroundImage: {
        'dark-hero': 'var(--background-dots), linear-gradient(135deg, var(--bg-base) 0%, var(--bg-contrast) 100%)',
        'dark-hero-no-dots': 'linear-gradient(135deg, var(--bg-base) 0%, var(--bg-contrast) 100%)',
        'layered-dark': `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Ccircle cx='1' cy='1' r='0.6' fill='rgba(255,255,255,0.03)'/%3E%3C/svg%3E"), linear-gradient(135deg,#050605 0%,#090B09 100%)`
      }
    }
  },
  plugins: [],
};