import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const alertVariants = cva("flex gap-3 rounded-xl border p-4 text-sm [&>svg]:mt-0.5 [&>svg]:size-5 [&>svg]:shrink-0", {
  variants: {
    tone: {
      info: "border-info/20 bg-info-soft text-foreground [&>svg]:text-info",
      success: "border-success/20 bg-success-soft text-foreground [&>svg]:text-success",
      warning: "border-warning/25 bg-warning-soft text-foreground [&>svg]:text-warning",
      danger: "border-danger/25 bg-danger-soft text-foreground [&>svg]:text-danger",
      neutral: "border-border bg-surface-muted text-foreground [&>svg]:text-muted-foreground",
    },
  },
  defaultVariants: { tone: "info" },
});

export function Alert({ className, tone, ...props }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return <div role={tone === "danger" ? "alert" : "status"} className={cn(alertVariants({ tone }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("font-semibold", className)} {...props} />;
}
