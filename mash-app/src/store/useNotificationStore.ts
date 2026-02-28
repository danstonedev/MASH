/**
 * Notification Store - Toast notifications for user feedback
 */

import { create } from 'zustand';

export type NotificationType = 'success' | 'error' | 'warning' | 'info';

export interface Notification {
    id: string;
    type: NotificationType;
    title: string;
    message?: string;
    duration?: number; // ms, 0 = persistent
    action?: {
        label: string;
        onClick: () => void;
    };
}

interface NotificationState {
    notifications: Notification[];
    
    // Actions
    addNotification: (notification: Omit<Notification, 'id'>) => string;
    removeNotification: (id: string) => void;
    clearAll: () => void;
    
    // Convenience methods
    success: (title: string, message?: string) => void;
    error: (title: string, message?: string) => void;
    warning: (title: string, message?: string) => void;
    info: (title: string, message?: string) => void;
}

let notificationId = 0;

export const useNotificationStore = create<NotificationState>((set, get) => ({
    notifications: [],
    
    addNotification: (notification) => {
        const id = `notification-${++notificationId}`;
        const newNotification: Notification = {
            ...notification,
            id,
            duration: notification.duration ?? 4000, // Default 4s
        };
        
        set(state => ({
            notifications: [...state.notifications, newNotification]
        }));
        
        // Auto-remove after duration (unless duration is 0)
        if (newNotification.duration && newNotification.duration > 0) {
            setTimeout(() => {
                get().removeNotification(id);
            }, newNotification.duration);
        }
        
        return id;
    },
    
    removeNotification: (id) => {
        set(state => ({
            notifications: state.notifications.filter(n => n.id !== id)
        }));
    },
    
    clearAll: () => {
        set({ notifications: [] });
    },
    
    // Convenience methods
    success: (title, message) => {
        get().addNotification({ type: 'success', title, message });
    },
    
    error: (title, message) => {
        get().addNotification({ type: 'error', title, message, duration: 6000 }); // Errors stay longer
    },
    
    warning: (title, message) => {
        get().addNotification({ type: 'warning', title, message, duration: 5000 });
    },
    
    info: (title, message) => {
        get().addNotification({ type: 'info', title, message });
    },
}));
