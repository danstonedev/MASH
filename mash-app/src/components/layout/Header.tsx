import { Activity, HelpCircle } from 'lucide-react';

export function Header() {
    return (
        <header className="h-14 border-b border-border bg-bg-surface flex items-center justify-between px-4">
            {/* Logo */}
            <div className="flex items-center gap-2">
                <Activity className="text-accent h-5 w-5" aria-hidden="true" />
                <h1 className="text-lg font-semibold tracking-tight text-text-primary">
                    M<span className="text-accent">ASH</span>
                </h1>
            </div>

            {/* Help Button */}
            <button
                onClick={() => window.open('https://github.com/danstonedev/connect2imu#readme', '_blank')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:text-white hover:bg-white/10 transition-colors"
                aria-label="Open help documentation"
            >
                <HelpCircle className="h-4 w-4" aria-hidden="true" />
                <span className="text-xs font-medium">Help</span>
            </button>
        </header>
    );
}
