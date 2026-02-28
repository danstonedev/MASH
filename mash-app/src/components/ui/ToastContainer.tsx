import React from 'react';
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { useNotificationStore, type NotificationType } from '../../store/useNotificationStore';
import { cn } from '../../lib/utils';

const iconMap: Record<NotificationType, React.ReactNode> = {
    success: <CheckCircle className="h-5 w-5" />,
    error: <AlertCircle className="h-5 w-5" />,
    warning: <AlertTriangle className="h-5 w-5" />,
    info: <Info className="h-5 w-5" />,
};

const styleMap: Record<NotificationType, string> = {
    success: 'bg-accent/95 border-accent',
    error: 'bg-red-600/95 border-red-500',
    warning: 'bg-amber-600/95 border-amber-500',
    info: 'bg-blue-600/95 border-blue-500',
};

export function ToastContainer() {
    const notifications = useNotificationStore(state => state.notifications);
    const removeNotification = useNotificationStore(state => state.removeNotification);

    if (notifications.length === 0) return null;

    return (
        <div className="fixed top-20 right-4 z-[1001] flex flex-col gap-2 max-w-sm">
            {notifications.map((notification) => (
                <div
                    key={notification.id}
                    className={cn(
                        "flex items-start gap-3 p-4 rounded-lg border shadow-lg",
                        "backdrop-blur-sm text-white",
                        "animate-in slide-in-from-right duration-300",
                        styleMap[notification.type]
                    )}
                >
                    <div className="flex-shrink-0 mt-0.5">
                        {iconMap[notification.type]}
                    </div>

                    <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm">{notification.title}</p>
                        {notification.message && (
                            <p className="text-xs text-white/80 mt-0.5">{notification.message}</p>
                        )}
                        {notification.action && (
                            <button
                                onClick={notification.action.onClick}
                                className="mt-2 text-xs font-medium underline hover:no-underline"
                            >
                                {notification.action.label}
                            </button>
                        )}
                    </div>

                    <button
                        onClick={() => removeNotification(notification.id)}
                        className="flex-shrink-0 p-1 hover:bg-white/20 rounded transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
            ))}
        </div>
    );
}
