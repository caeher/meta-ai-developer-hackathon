import { createElement, type AnchorHTMLAttributes } from "react";

export default function LinkFixture({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return createElement("a", { href, ...props });
}
