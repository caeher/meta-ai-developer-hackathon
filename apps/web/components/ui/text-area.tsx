import { TextArea as RadixTextArea, type TextAreaProps } from "@radix-ui/themes";

export type { TextAreaProps };

export function TextArea({ size = "3", ...props }: TextAreaProps) {
  return <RadixTextArea size={size} {...props} />;
}
