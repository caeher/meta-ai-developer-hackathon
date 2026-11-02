import { Button as RadixButton, type ButtonProps as RadixButtonProps } from "@radix-ui/themes";

export type ButtonProps = RadixButtonProps;

export function Button({ type = "button", variant = "solid", size = "2", ...props }: ButtonProps) {
  return <RadixButton type={type} variant={variant} size={size} {...props} />;
}
