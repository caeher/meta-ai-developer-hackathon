"use client";

import { Badge, Button, Checkbox, Dialog, Select, Text } from "@radix-ui/themes";
import type { PreviewVersion } from "./preview-toolbar";
import styles from "./EditorShell.module.css";

export interface EditorPublication {
  id: string;
  versionId: string;
  versionNumber: number;
  status: "pending" | "ready" | "failed" | "revoked";
  idempotencyKey: string | null;
  artifactSha256: string | null;
  url: string | null;
  createdAt: string;
}

const statusText: Record<EditorPublication["status"], string> = {
  pending: "En proceso",
  ready: "Publicada",
  failed: "Falló",
  revoked: "Revocada",
};

const statusColor: Record<EditorPublication["status"], "orange" | "green" | "red" | "gray"> = {
  pending: "orange", ready: "green", failed: "red", revoked: "gray",
};

export function PublishDialog(props: {
  enabled: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  versions: readonly PreviewVersion[];
  selectedVersionId: string;
  onVersionChange(versionId: string): void;
  confirmed: boolean;
  onConfirmedChange(confirmed: boolean): void;
  publishing: boolean;
  onPublish(): void;
  publications: readonly EditorPublication[];
  onShare(publication: EditorPublication): void;
  onRevoke(publication: EditorPublication): void;
  onRetry(publication: EditorPublication): void;
}) {
  const readyVersions = props.enabled ? props.versions.filter((version) => version.status === "ready") : [];
  const selected = readyVersions.find((version) => version.id === props.selectedVersionId) ?? readyVersions[0];

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Trigger>
        <Button variant="soft" disabled={readyVersions.length === 0} title={readyVersions.length ? undefined : "Publicar requiere una versión verificada."}>
          Publish
        </Button>
      </Dialog.Trigger>
      <Dialog.Content className={styles.publishDialog} maxWidth="560px">
        <Dialog.Title>Publicar una build estática</Dialog.Title>
        <Dialog.Description>
          Se reconstruirá una versión verificada en un sandbox aislado. La publicación será anónima en su propio dominio; no abre la preview privada ni comparte el chat o las fuentes.
        </Dialog.Description>
        <section className={styles.publishSection} aria-label="Build que se publicará">
          <label htmlFor="publish-version">Versión verificada</label>
          <Select.Root value={selected?.id ?? ""} onValueChange={props.onVersionChange} disabled={readyVersions.length === 0}>
            <Select.Trigger id="publish-version" aria-label="Versión a publicar" />
            <Select.Content>
              {readyVersions.map((version) => <Select.Item key={version.id} value={version.id}>v{version.versionNumber} · verificada</Select.Item>)}
            </Select.Content>
          </Select.Root>
          {selected ? <Text as="p" size="1" color="gray">El build vuelve a instalar dependencias exactas y verifica los archivos que se servirán.</Text> : <Text as="p" color="gray">Aún no hay una versión verificada para publicar.</Text>}
        </section>
        <label className={styles.publishConsent} htmlFor="publish-public-confirmation">
          <Checkbox id="publish-public-confirmation" checked={props.confirmed} onCheckedChange={(checked) => props.onConfirmedChange(checked === true)} />
          <span>Entiendo que el juego y sus recursos compilados quedarán accesibles para cualquiera que tenga la URL.</span>
        </label>
        <div className={styles.dialogActions}>
          <Dialog.Close><Button variant="soft" disabled={props.publishing}>Cerrar</Button></Dialog.Close>
          <Button onClick={props.onPublish} disabled={!selected || !props.confirmed || props.publishing}>
            {props.publishing ? "Preparando build…" : `Publicar v${selected?.versionNumber ?? ""}`}
          </Button>
        </div>
        <section className={styles.publicationHistory} aria-labelledby="publication-history-heading">
          <div className={styles.publicationHistoryTitle}>
            <h3 id="publication-history-heading">Historial de publicaciones</h3>
            <Text as="span" size="1" color="gray">Los enlaces se pueden revocar.</Text>
          </div>
          {props.publications.length ? (
            <ul>
              {props.publications.map((publication) => (
                <li key={publication.id}>
                  <div className={styles.publicationInfo}>
                    <div><strong>v{publication.versionNumber}</strong><Badge color={statusColor[publication.status]} variant="soft">{statusText[publication.status]}</Badge></div>
                    <Text as="span" size="1" color="gray">{new Date(publication.createdAt).toLocaleString()}</Text>
                    {publication.artifactSha256 ? <code>sha256:{publication.artifactSha256.slice(0, 12)}</code> : null}
                    {publication.url ? <a href={publication.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Abrir juego publicado</a> : null}
                  </div>
                  <div className={styles.publicationActions}>
                    {publication.status === "ready" ? <Button variant="soft" size="1" onClick={() => props.onShare(publication)}>Share</Button> : null}
                    {publication.status === "ready" || publication.status === "pending" ? <Button variant="soft" color="red" size="1" onClick={() => props.onRevoke(publication)}>Unpublish</Button> : null}
                    {publication.status === "failed" && publication.idempotencyKey ? <Button variant="soft" size="1" onClick={() => props.onRetry(publication)}>Reintentar</Button> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : <Text as="p" size="2" color="gray">Todavía no hay publicaciones.</Text>}
        </section>
      </Dialog.Content>
    </Dialog.Root>
  );
}
