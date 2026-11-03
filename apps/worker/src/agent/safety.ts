const sensitivePatterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_ -]?key|password|secret|access[_ -]?token|refresh[_ -]?token)\b\s*[:=]\s*["']?[A-Za-z0-9/+_.=-]{12,}/i,
  /\b(?:\d[ -]?){13,19}\b/,
];

const phoneLikePattern = /(?:\+?\d[\d ().-]{7,}\d)/;
const outputRedactionPatterns = [...sensitivePatterns, phoneLikePattern].map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`));
const secretPathPattern = /(?:^|\/)(?:\.env(?:\.[^/]*)?|id_rsa(?:\.[^/]*)?|authorized_keys|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|service[-_]?account(?:\.[^/]*)?|kubeconfig|[^/]+\.(?:pem|key|p12|pfx))(?:$|\/)/i;

export function sensitiveInputReason(value: string): "sensitive_content" | undefined {
  const text = value.replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, " ");
  return sensitivePatterns.some((pattern) => pattern.test(text)) || phoneLikePattern.test(text)
    ? "sensitive_content"
    : undefined;
}

export function redactSensitiveText(value: string): string {
  return outputRedactionPatterns.reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), value);
}

export function isSensitiveWorkspacePath(value: string): boolean {
  return secretPathPattern.test(value.replaceAll("\\", "/"));
}

export function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 3);
}
