"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Callout, Flex, Heading, Text, TextField } from "@radix-ui/themes";

type AuthFormMode = "login" | "register" | "forgot-password" | "reset-password" | "verify-email";

const titles: Record<AuthFormMode, string> = {
  login: "Iniciar sesión",
  register: "Crear cuenta",
  "forgot-password": "Recuperar contraseña",
  "reset-password": "Elegir una contraseña nueva",
  "verify-email": "Verificar correo electrónico",
};

export function AuthForm({ mode }: { mode: AuthFormMode }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const needsEmail = mode === "login" || mode === "register" || mode === "forgot-password";
  const needsPassword = mode === "login" || mode === "register" || mode === "reset-password";
  const submitLabel = mode === "login" ? "Entrar" : mode === "register" ? "Enviar verificación" : mode === "forgot-password" ? "Enviar instrucciones" : mode === "reset-password" ? "Guardar contraseña" : "Verificar correo";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    const form = new FormData(event.currentTarget);
    const body: Record<string, string> = {};
    if (needsEmail) body.email = String(form.get("email") ?? "");
    if (needsPassword) body.password = String(form.get("password") ?? "");
    if (mode === "reset-password" || mode === "verify-email") {
      body.token = new URLSearchParams(window.location.search).get("token") ?? "";
    }
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { error?: string; message?: string };
      if (!response.ok) {
        setError(result.error === "invalid_credentials" ? "Correo o contraseña incorrectos." : result.error === "invalid_or_expired_link" ? "El enlace no es válido o ya venció." : result.error === "try_again_later" ? "Espera un momento antes de volver a intentarlo." : result.error === "email_delivery_unavailable" ? "El envío de correo no está disponible en este entorno." : "No se pudo completar la solicitud. Revisa los datos e inténtalo de nuevo.");
        return;
      }
      if (mode === "login") {
        router.push("/projects");
        router.refresh();
      } else if (mode === "reset-password") {
        setMessage("La contraseña se actualizó. Ya puedes iniciar sesión.");
      } else if (mode === "verify-email") {
        setMessage("Correo verificado. Ya puedes iniciar sesión.");
      } else {
        setMessage(result.message ?? "Si la cuenta puede procesarse, recibirás un correo con los siguientes pasos.");
      }
    } catch {
      setError("No se pudo conectar con el servicio. Inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-card" aria-labelledby="auth-title">
      <Heading as="h1" id="auth-title" size="6">{titles[mode]}</Heading>
      <Text as="p" color="gray">Accede a tu espacio privado para crear juegos 2D.</Text>
      <form className="auth-form" onSubmit={submit}>
        {needsEmail ? (
          <label className="auth-field">
            <Text as="span" size="2">Correo electrónico</Text>
            <TextField.Root name="email" type="email" autoComplete="email" required maxLength={320} />
          </label>
        ) : null}
        {needsPassword ? (
          <label className="auth-field">
            <Text as="span" size="2">Contraseña</Text>
            <TextField.Root name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "login" ? 1 : 12} maxLength={128} />
            {mode !== "login" ? <Text as="span" size="1" color="gray">Usa al menos 12 caracteres.</Text> : null}
          </label>
        ) : null}
        {error ? <Callout.Root color="red" role="alert"><Callout.Text>{error}</Callout.Text></Callout.Root> : null}
        {message ? <Callout.Root color="green" role="status"><Callout.Text>{message}</Callout.Text></Callout.Root> : null}
        <Button type="submit" disabled={busy} className="auth-submit">{busy ? "Procesando…" : submitLabel}</Button>
      </form>
      <Flex justify="between" wrap="wrap" gap="3" className="auth-links">
        {mode === "login" ? <Link href="/forgot-password">Olvidé mi contraseña</Link> : null}
        {mode === "login" ? <Link href="/sign-up">Crear cuenta</Link> : null}
        {mode === "register" ? <Link href="/sign-in">Ya tengo una cuenta</Link> : null}
        {mode === "forgot-password" || mode === "reset-password" || mode === "verify-email" ? <Link href="/sign-in">Volver a iniciar sesión</Link> : null}
      </Flex>
      {mode === "register" ? <Text as="p" size="1" color="gray">Te enviaremos un enlace de verificación antes de habilitar la sesión.</Text> : null}
    </section>
  );
}
