import React, { useEffect, useState, useRef } from 'react';
import './SuccessToast.css';

interface SuccessToastProps {
    message: string;
    isVisible: boolean;
    onHide: () => void;
    duration?: number;
}

export const SuccessToast: React.FC<SuccessToastProps> = ({
    message,
    isVisible,
    onHide,
    duration = 3000
}) => {
    const [isExiting, setIsExiting] = useState(false);
    const onHideRef = useRef(onHide);
    onHideRef.current = onHide;

    useEffect(() => {
        if (isVisible && !isExiting) {
            // Start auto-hide timer
            const hideTimer = setTimeout(() => {
                setIsExiting(true);
            }, duration);

            return () => clearTimeout(hideTimer);
        }
    }, [isVisible, duration, isExiting]);

    // Handle exit animation completion
    useEffect(() => {
        if (isExiting) {
            const exitTimer = setTimeout(() => {
                setIsExiting(false);
                onHideRef.current();
            }, 300);
            return () => clearTimeout(exitTimer);
        }
    }, [isExiting]);

    if (!isVisible && !isExiting) return null;

    return (
        <div className={`success-toast ${isExiting ? 'exiting' : ''}`}>
            <div className="toast-icon">✓</div>
            <span className="toast-message">{message}</span>
        </div>
    );
};

export default SuccessToast;

