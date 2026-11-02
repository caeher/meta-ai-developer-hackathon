import { Avatar as RadixAvatar, type AvatarProps } from "@radix-ui/themes";

export type { AvatarProps };

export function Avatar({ size = "3", radius = "full", ...props }: AvatarProps) {
  return <RadixAvatar size={size} radius={radius} {...props} />;
}
