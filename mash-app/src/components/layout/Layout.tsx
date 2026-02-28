import type { ReactNode } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

interface LayoutProps {
    children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
    return (
        <div className="flex h-screen bg-cyber-dark text-cyber-text overflow-hidden font-sans">
            <div className="flex-1 flex flex-col min-w-0">
                <Header />
                <div className="flex flex-1 overflow-hidden">
                    <Sidebar />
                    <main className="flex-1 overflow-y-auto p-6 relative">
                        {/* Grid Pattern Background */}
                        <div className="absolute inset-0 z-0 opacity-10 pointer-events-none"
                            style={{
                                backgroundImage: `linear-gradient(#2a2a35 1px, transparent 1px), linear-gradient(90deg, #2a2a35 1px, transparent 1px)`,
                                backgroundSize: '20px 20px'
                            }}
                        />
                        <div className="relative z-10 w-full max-w-7xl mx-auto">
                            {children}
                        </div>
                    </main>
                </div>
            </div>
        </div>
    );
}
