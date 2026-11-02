import { Tooltip as RadixTooltip, type TooltipProps } from "@radix-ui/themes";

export type { TooltipProps };

export function Tooltip({ side = "top", ...props }: TooltipProps) {
  return <RadixTooltip side={side} {...props} />;
}
