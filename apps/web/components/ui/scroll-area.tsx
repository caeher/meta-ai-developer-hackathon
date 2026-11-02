import { ScrollArea as RadixScrollArea, type ScrollAreaProps } from "@radix-ui/themes";

export type { ScrollAreaProps };

export function ScrollArea({ scrollbars = "vertical", size = "2", ...props }: ScrollAreaProps) {
  return <RadixScrollArea scrollbars={scrollbars} size={size} {...props} />;
}
