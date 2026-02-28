import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
    "inline-flex items-center justify-center whitespace-nowrap rounded-sm text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 uppercase tracking-wider",
    {
        variants: {
            variant: {
                default: "bg-accent text-white hover:bg-accent/90 font-bold",
                outline: "border border-accent text-accent hover:bg-accent/10",
                ghost: "hover:bg-accent/10 text-accent",
                danger: "bg-danger text-white hover:bg-danger/90",
                cyber: "bg-bg-elevated border border-accent text-accent hover:bg-accent hover:text-white shadow-[0_0_10px_rgba(0,154,68,0.3)] hover:shadow-[0_0_20px_rgba(0,154,68,0.5)] transition-all duration-300",
                gradient: "bg-gradient-to-r from-accent to-[#00B050] text-white shadow-[0_0_15px_rgba(0,154,68,0.3)] hover:shadow-[0_0_25px_rgba(0,154,68,0.5)] hover:from-accent/90 hover:to-[#00B050]/90 border border-white/10",
            },
            size: {
                default: "h-10 px-4 py-2",
                sm: "h-9 rounded-md px-3",
                lg: "h-11 rounded-md px-8",
                icon: "h-10 w-10",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    }
);

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
    asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
        return (
            <button
                className={cn(buttonVariants({ variant, size, className }))}
                ref={ref}
                {...props}
            />
        );
    }
);
Button.displayName = "Button";

export { Button, buttonVariants };
