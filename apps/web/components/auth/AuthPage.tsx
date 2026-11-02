import Link from "next/link";
import { AuthControls } from "./AuthControls";
import { AuthForm } from "./AuthForm";

export function AuthPage({ mode }: { mode: "login" | "register" | "forgot-password" | "reset-password" | "verify-email" }) {
  return (
    <main className="shell auth-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Forja, inicio">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span>Forja</span>
        </Link>
        <AuthControls />
      </header>
      <AuthForm mode={mode} />
    </main>
  );
}
