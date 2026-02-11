const THEME_KEY = 'machina.theme';
const DEFAULT_THEME = 'dark';

function getStoredTheme(): string {
    return localStorage.getItem(THEME_KEY) || DEFAULT_THEME;
}

function setTheme(theme: string) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
}

function toggleTheme() {
    const current = getStoredTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    setTheme(next);
}

async function checkHealth() {
    try {
        const res = await fetch('/health');
        const data = await res.json() as { status: string };
        const statusEl = document.getElementById('health-status');
        if (statusEl) {
            statusEl.textContent = data.status === 'ok' ? 'Operational' : 'Issue Detected';
            statusEl.style.color = data.status === 'ok' ? 'var(--machina-accent)' : 'red';
        }
    } catch (e) {
        console.error('Health check failed', e);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    setTheme(getStoredTheme());

    const toggleBtn = document.getElementById('theme-toggle');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', toggleTheme);
    }

    checkHealth();
});
