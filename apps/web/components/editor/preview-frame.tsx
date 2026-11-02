"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Heading } from "@radix-ui/themes";
import { requestPreviewGrant } from "./preview-client";
import { getPreviewOrigin, parsePreviewRouteMessage, parsePreviewRoutePath } from "./preview-protocol";
import { PreviewToolbar, type PreviewStatus, type PreviewVersion } from "./preview-toolbar";
import styles from "./PreviewFrame.module.css";

const frameLoadTimeoutMs = 15_000;

type HistoryState = { entries: string[]; index: number };

class PreviewCookieUnavailableError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function exchangeGrant(origin: string, grant: string): Promise<number> {
  const response = await fetch(`${origin}/__session`, {
    method: "POST",
    mode: "cors",
    credentials: "include",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant }),
  });
  if (!response.ok) {
    await response.json().catch(() => null);
    throw new Error("El gateway rechazó la sesión de preview. Solicita una nueva.");
  }
  const payload = await response.json() as unknown;
  if (!isRecord(payload) || payload.ok !== true || typeof payload.expiresAt !== "string") {
    throw new Error("El gateway devolvió una respuesta de sesión inválida.");
  }
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("La sesión de preview ya venció.");

  const health = await fetch(`${origin}/__session`, {
    method: "GET",
    mode: "cors",
    credentials: "include",
    cache: "no-store",
  });
  if (!health.ok) throw new PreviewCookieUnavailableError("El navegador no conservó la cookie particionada de preview.");
  return expiresAt;
}

export function PreviewFrame({
  projectId,
  baseDomain,
  versions = [],
}: {
  projectId: string;
  baseDomain?: string;
  versions?: readonly PreviewVersion[];
}) {
  const origin = useMemo(() => getPreviewOrigin(projectId, baseDomain), [projectId, baseDomain]);
  const initialStatus: PreviewStatus = origin ? "booting" : "disabled";
  const [status, setStatus] = useState<PreviewStatus>(initialStatus);
  const [frameUrl, setFrameUrl] = useState<string>();
  const [frameKey, setFrameKey] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [history, setHistory] = useState<HistoryState>({ entries: ["/"], index: 0 });
  const frameRef = useRef<HTMLIFrameElement>(null);
  const statusRef = useRef(status);
  const operationRef = useRef(0);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const updateStatus = useCallback((next: PreviewStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const clearTimers = useCallback(() => {
    if (expiryTimerRef.current) clearTimeout(expiryTimerRef.current);
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    expiryTimerRef.current = undefined;
    loadTimerRef.current = undefined;
  }, []);

  const startPreview = useCallback(async () => {
    if (!origin) return;
    const operation = ++operationRef.current;
    clearTimers();
    setFrameUrl(undefined);
    setErrorMessage("");
    setHistory({ entries: ["/"], index: 0 });
    updateStatus("booting");
    try {
      const { grant } = await requestPreviewGrant(projectId, origin);
      const expiresAt = await exchangeGrant(origin, grant);
      if (operation !== operationRef.current) return;
      setFrameUrl(`${origin}/`);
      setFrameKey((current) => current + 1);
      updateStatus("loading");
      loadTimerRef.current = setTimeout(() => {
        if (statusRef.current !== "loading") return;
        setFrameUrl(undefined);
        setErrorMessage("La preview tardó demasiado en responder.");
        updateStatus("error");
      }, frameLoadTimeoutMs);
      expiryTimerRef.current = setTimeout(() => {
        if (operation !== operationRef.current) return;
        setFrameUrl(undefined);
        setErrorMessage("La sesión privada de preview venció. Renueva el grant para continuar.");
        updateStatus("expired");
      }, Math.max(0, expiresAt - Date.now()));
    } catch (error) {
      if (operation !== operationRef.current) return;
      clearTimers();
      setFrameUrl(undefined);
      setErrorMessage(error instanceof PreviewCookieUnavailableError
        ? "El navegador bloqueó la cookie de terceros. Abre la preview en una pestaña para crear la sesión como origen principal."
        : error instanceof Error ? error.message : "No se pudo cargar la preview privada.");
      updateStatus("error");
    }
  }, [clearTimers, origin, projectId, updateStatus]);

  useEffect(() => {
    if (origin) void startPreview();
    return () => {
      operationRef.current += 1;
      clearTimers();
    };
  }, [clearTimers, origin, startPreview]);

  useEffect(() => {
    if (!origin) return;
    function handleMessage(event: MessageEvent<unknown>) {
      const frame = frameRef.current;
      if (!frame?.contentWindow || event.origin !== origin || event.source !== frame.contentWindow) return;
      const routeMessage = parsePreviewRouteMessage(event.data);
      if (!routeMessage) return;
      setHistory((current) => {
        if (current.entries[current.index] === routeMessage.path) return current;
        const prior = current.entries.slice(0, current.index + 1);
        const entries = [...prior, routeMessage.path].slice(-50);
        return { entries, index: entries.length - 1 };
      });
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [origin]);

  function navigateToKnownPath(path: string) {
    if (!origin) return;
    const safePath = parsePreviewRoutePath(path);
    if (!safePath) return;
    setFrameUrl(`${origin}${safePath}`);
    setFrameKey((current) => current + 1);
    clearTimers();
    updateStatus("loading");
    loadTimerRef.current = setTimeout(() => {
      if (statusRef.current !== "loading") return;
      setFrameUrl(undefined);
      setErrorMessage("La ruta conocida de la preview no respondió.");
      updateStatus("error");
    }, frameLoadTimeoutMs);
  }

  function navigateHistory(direction: -1 | 1) {
    const nextIndex = history.index + direction;
    const path = history.entries[nextIndex];
    if (nextIndex < 0 || nextIndex >= history.entries.length || !path) return;
    setHistory((current) => ({ ...current, index: nextIndex }));
    navigateToKnownPath(path);
  }

  function onFrameLoad() {
    if (statusRef.current !== "loading") return;
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    loadTimerRef.current = undefined;
    updateStatus("ready");
  }

  const busy = status === "booting" || status === "loading";
  const failed = status === "error" || status === "expired";
  const openTabHref = `/projects/${encodeURIComponent(projectId)}/preview/handoff`;

  return (
    <div className={styles.preview}>
      <PreviewToolbar
        status={status}
        enabled={Boolean(origin)}
        openTabHref={openTabHref}
        versions={versions}
        historyIndex={history.index}
        historyLength={history.entries.length}
        onBack={() => navigateHistory(-1)}
        onForward={() => navigateHistory(1)}
        onReload={() => void startPreview()}
      />
      <div className={styles.stage}>
        {frameUrl ? (
          <iframe
            key={frameKey}
            ref={frameRef}
            className={styles.frame}
            src={frameUrl}
            title="Preview privada del juego"
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            allow=""
            onLoad={onFrameLoad}
          />
        ) : null}
        {status === "disabled" ? (
          <div className={styles.message}>
            <Heading as="h2" size="4">Preview privada deshabilitada</Heading>
            <p>Se habilitará cuando el gateway tenga dominio, TLS y host de ejecución validados.</p>
          </div>
        ) : null}
        {busy ? (
          <div className={styles.message} role="status" aria-live="polite">
            <Heading as="h2" size="4">{status === "booting" ? "Conectando con el sandbox…" : "Cargando el juego…"}</Heading>
            <p>La sesión se autoriza para este proyecto y vence automáticamente.</p>
          </div>
        ) : null}
        {failed ? (
          <div className={styles.message}>
            <Heading as="h2" size="4">{status === "expired" ? "La sesión venció" : "No se pudo cargar la preview"}</Heading>
            <p>{errorMessage}</p>
            <div className={styles.messageActions}>
              <Button onClick={() => void startPreview()} disabled={busy}>Renovar y recargar</Button>
              {origin ? <a className={styles.openTab} href={openTabHref} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Abrir en una pestaña</a> : null}
            </div>
          </div>
        ) : null}
      </div>
      <div className={`${styles.status} ${failed ? styles.statusError : status === "ready" ? styles.statusSuccess : ""}`} aria-live="polite">
        <p>{status === "disabled" ? "La feature flag PREVIEW_GATEWAY_ENABLED está apagada o falta PREVIEW_BASE_DOMAIN." :
          status === "booting" ? "Solicitando un grant de un solo uso…" :
          status === "loading" ? "Sesión autorizada; esperando la respuesta del iframe…" :
          status === "ready" ? "La preview privada está lista." :
          status === "expired" ? "La sesión expiró; renueva para continuar." : errorMessage}</p>
      </div>
    </div>
  );
}
