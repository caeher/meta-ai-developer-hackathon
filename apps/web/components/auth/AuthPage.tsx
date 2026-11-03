import Link from "next/link";
import { AuthForm } from "./AuthForm";

export function AuthPage({ mode }: { mode: "login" | "register" | "forgot-password" | "reset-password" | "verify-email" }) {
  return (
    <main className="auth-layout">
      <aside className="auth-aside" aria-label="Forja">
        <Link className="brand auth-brand" href="/" aria-label="Forja, inicio">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span>Forja</span>
        </Link>
        <div className="auth-aside-copy">
          <span className="auth-kicker"><span className="auth-kicker-dot" /> TU TALLER CREATIVO
          </span>
          <h2>De una idea a un juego que puedes jugar.</h2>
          <p>Un espacio para diseñar, construir y probar juegos 2D, paso a paso y con ayuda de IA.</p>
        </div>
        <div className="auth-art" aria-hidden="true">
          <div className="auth-art-grid" />
          <div className="auth-art-orbit auth-art-orbit-one" />
          <div className="auth-art-orbit auth-art-orbit-two" />
          <div className="auth-art-spark auth-art-spark-one">✦</div>
          <div className="auth-art-spark auth-art-spark-two">✧</div>
          <div className="auth-art-cube"><span>F</span></div>
          <div className="auth-art-caption"><span>01</span> IMAGINA · CONSTRUYE · JUEGA</div>
        </div>
        <p className="auth-aside-footer">Hecho para quienes convierten ideas en mundos.</p>
      </aside>
      <section className="auth-main">
        <div className="auth-mobile-brand"><Link className="brand" href="/"><span className="brand-mark" aria-hidden="true">F</span><span>Forja</span></Link></div>
        <noscript><p className="auth-noscript">Esta página necesita JavaScript para crear tu cuenta o iniciar sesión. Actívalo en tu navegador (o permite este sitio en tu bloqueador) y recarga la página.</p></noscript>
        <AuthForm mode={mode} />
        <p className="auth-privacy-note">Al continuar, tu espacio y tus proyectos son solo tuyos.</p>
      </section>
    </main>
  );
}
