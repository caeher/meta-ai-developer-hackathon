export const MAX_PROMPT_LENGTH = 100_000;

export function appendPromptText(current: string, addition: string): string {
  const separator = current.trim().length > 0 ? "\n" : "";
  return `${current}${separator}${addition}`.slice(0, MAX_PROMPT_LENGTH);
}
