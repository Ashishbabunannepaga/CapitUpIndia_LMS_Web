import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/** A styled native <select>: works in plain forms, keyboards and screen readers. */
function NativeSelect({ className, size = "default", ...props }: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  return (
    <div className={cn("relative w-full min-w-0", className)} data-slot="native-select-wrapper">
      <select
        data-slot="native-select"
        className={cn(
          "w-full min-w-0 appearance-none rounded-md border border-input bg-background pr-8 pl-3 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/30",
          size === "sm" ? "h-8" : "h-9",
        )}
        {...props}
      />
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

export { NativeSelect };
