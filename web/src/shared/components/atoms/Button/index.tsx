import { type ButtonHTMLAttributes, forwardRef } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "ghost" | "danger" | "icon";
  size?: "sm" | "md" | "lg";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "default", size = "md", className = "", children, ...props }, ref) => {
    const base = "inline-flex items-center justify-center font-medium transition-colors select-none rounded-[6px] disabled:opacity-50 disabled:pointer-events-none";
    const sizes = {
      sm: "h-6 px-2 text-xs",
      md: "h-7 px-2.5 text-xs",
      lg: "h-8 px-3 text-sm",
    };
    const variants = {
      default: "bg-surface border border-line text-text hover:bg-hover active:bg-active",
      primary: "bg-accent text-white hover:opacity-90 active:opacity-100",
      ghost: "bg-transparent text-text-muted hover:text-text hover:bg-hover active:bg-active",
      danger: "bg-danger text-white hover:opacity-90",
      icon: "h-7 w-7 p-0 bg-transparent text-text-muted hover:text-text hover:bg-hover",
    };

    return (
      <button
        ref={ref}
        type="button"
        className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
