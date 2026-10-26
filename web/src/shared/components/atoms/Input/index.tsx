import { type InputHTMLAttributes, forwardRef } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ error = false, className = "", ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={`h-7 w-full rounded-[6px] border bg-surface px-2 text-xs text-text outline-none transition-colors placeholder:text-text-muted focus:border-accent ${
          error ? "border-danger" : "border-line"
        } ${className}`}
        {...props}
      />
    );
  }
);

Input.displayName = "Input";
