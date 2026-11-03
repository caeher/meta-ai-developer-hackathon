"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Callout, Checkbox, Flex, Heading, Text, TextField } from "@radix-ui/themes";
import { useToast } from "../ui/toast";

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
  const { toast } = useToast();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [contributorConsent, setContributorConsent] = useState(false);
  const needsEmail = mode === "login" || mode === "register" || mode === "forgot-password";
  const needsPassword = mode === "login" || mode === "register" || mode === "reset-password";
  const needsConfirm = mode === "register" || mode === "reset-password";
  const submitLabel = mode === "login" ? "Entrar" : mode === "register" ? "Enviar verificación" : mode === "forgot-password" ? "Enviar instrucciones" : mode === "reset-password" ? "Guardar contraseña" : "Verificar correo";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    const fail = (text: string) => {
      setError(text);
      toast({ tone: "error", title: text });
    };
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {};
    if (needsEmail) body.email = String(form.get("email") ?? "");
    if (needsPassword) body.password = String(form.get("password") ?? "");
    if (needsConfirm && String(form.get("confirmPassword") ?? "") !== body.password) {
      setBusy(false);
      fail("Las contraseñas no coinciden.");
      return;
    }
    if (mode === "register") {
      if (!contributorConsent) {
        setBusy(false);
        fail("Debes confirmar que tienes 18 años o más y aceptar los términos de Meta Contributor.");
        return;
      }
      body.contributorConsent = true;
    }
    if (mode === "reset-password" || mode === "verify-email") {
      body.token = new URLSearchParams(window.location.search).get("token") ?? "";
      if (!body.token) {
        setBusy(false);
        fail("Falta el token en el enlace. Pide un enlace nuevo.");
        return;
      }
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
        fail(result.error === "invalid_credentials" ? "Correo o contraseña incorrectos." : result.error === "invalid_or_expired_link" ? "El enlace no es válido o ya venció." : result.error === "try_again_later" ? "Espera un momento antes de volver a intentarlo." : result.error === "email_delivery_unavailable" ? "El envío de correo no está disponible en este entorno." : "No se pudo completar la solicitud. Revisa los datos e inténtalo de nuevo.");
        return;
      }
      if (mode === "login") {
        toast({ tone: "ok", title: "Sesión iniciada." });
        router.push("/projects");
        router.refresh();
      } else if (mode === "reset-password") {
        const text = "La contraseña se actualizó. Ya puedes iniciar sesión.";
        setMessage(text);
        toast({ tone: "ok", title: text });
      } else if (mode === "verify-email") {
        const text = "Correo verificado. Ya puedes iniciar sesión.";
        setMessage(text);
        toast({ tone: "ok", title: text });
      } else {
        const text = result.message ?? "Si la cuenta puede procesarse, recibirás un correo con los siguientes pasos.";
        setMessage(text);
        toast({ tone: "info", title: text });
      }
    } catch {
      fail("No se pudo conectar con el servicio. Inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-card" aria-labelledby="auth-title">
      <Text as="p" className="auth-form-kicker">FORJA · JUEGOS 2D</Text>
      <Heading as="h1" id="auth-title" size="6">{titles[mode]}</Heading>
      <Text as="p" color="gray">Accede a tu espacio privado para crear juegos 2D.</Text>
      <form className="auth-form" method="post" onSubmit={submit}>
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
        {needsConfirm ? (
          <label className="auth-field">
            <Text as="span" size="2">Confirmar contraseña</Text>
            <TextField.Root name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} />
            <Text as="span" size="1" color="gray">Repite la contraseña para evitar errores.</Text>
          </label>
        ) : null}
        {mode === "register" ? (
          <label className="auth-field">
            <Flex gap="2" align="start">
              <Checkbox name="contributorConsent" checked={contributorConsent} onCheckedChange={(checked) => setContributorConsent(checked === true)} />
              <Text as="span" size="1">Confirmo que tengo 18 años o más y acepto los términos de Meta Contributor: el proveedor puede usar las entradas para entrenamiento. No incluir datos personales, secretos ni información confidencial.</Text>
            </Flex>
          </label>
        ) : null}
        {error ? <Callout.Root color="red" role="alert"><Callout.Text>{error}</Callout.Text></Callout.Root> : null}
        {message ? <Callout.Root color="green" role="status"><Callout.Text>{message}</Callout.Text></Callout.Root> : null}
        <Button type="submit" disabled={busy || (mode === "register" && !contributorConsent)} className="auth-submit">{busy ? "Procesando…" : submitLabel}</Button>
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
