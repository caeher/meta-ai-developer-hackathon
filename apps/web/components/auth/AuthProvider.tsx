"use client";

import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";

export function AuthProvider({
  children,
  configured,
  publishableKey,
}: {
  children: ReactNode;
  configured: boolean;
  publishableKey?: string;
}) {
  if (!configured || !publishableKey) return children;

  return <ClerkProvider publishableKey={publishableKey}>{children}</ClerkProvider>;
}
