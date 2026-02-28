import { create } from 'zustand';
import type { SidebarTab } from '../components/layout/NavigationRail';

interface NavigationState {
    activeTab: SidebarTab;
    setActiveTab: (tab: SidebarTab) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
    activeTab: 'connect',
    setActiveTab: (tab) => set({ activeTab: tab }),
}));
