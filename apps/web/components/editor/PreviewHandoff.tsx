"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Heading } from "@radix-ui/themes";
import { requestPreviewGrant } from "./preview-client";
import { getPreviewOrigin } from "./preview-protocol";
import styles from "./PreviewHandoff.module.css";

type HandoffStatus = "booting" | "submitting" | "error";

export function PreviewHandoff({
  projectId,
  projectName,
  baseDomain,
  protocol = "https:",
}: {
  projectId: string;
  projectName: string;
  baseDomain?: string;
  protocol?: "http:" | "https:";
}) {
  const origin = useMemo(() => getPreviewOrigin(projectId, baseDomain, protocol), [projectId, baseDomain, protocol]);
  const [status, setStatus] = useState<HandoffStatus>("booting");
  const [grant, setGrant] = useState("");
  const [message, setMessage] = useState("Solicitando una sesión privada de primer nivel…");
  const formRef = useRef<HTMLFormElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (!origin) {
      setStatus("error");
      setMessage("La preview privada no está habilitada en este entorno.");
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    void requestPreviewGrant(projectId, origin, controller.signal).then(({ grant: nextGrant }) => {
      if (cancelled) return;
      setGrant(nextGrant);
      setStatus("submitting");
      setMessage("La sesión se está creando en el origen privado de la preview…");
    }).catch((error: unknown) => {
      if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "No se pudo preparar la sesión privada.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [origin, projectId]);

  useEffect(() => {
    if (!grant || !formRef.current || submittedRef.current) return;
    submittedRef.current = true;
    formRef.current.setAttribute("referrerpolicy", "no-referrer");
    formRef.current.submit();
  }, [grant]);

  return (
    <main className={styles.handoff}>
      <Heading as="h1" size="5">Abriendo preview privada</Heading>
      <p className={styles.projectName}>{projectName}</p>
      <p role="status" aria-live="polite">{message}</p>
      {status === "error" ? <Link href={`/projects/${encodeURIComponent(projectId)}`}>Volver al editor</Link> : null}
      {origin && grant ? (
        <form
          ref={formRef}
          action={`${origin}/__session`}
          method="post"
          encType="application/x-www-form-urlencoded"
          aria-hidden="true"
        >
          <input type="hidden" name="grant" value={grant} />
        </form>
      ) : null}
    </main>
  );
}
