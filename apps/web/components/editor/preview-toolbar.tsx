"use client";

import { Badge, Button, Select, Text } from "@radix-ui/themes";
import styles from "./PreviewFrame.module.css";

export type PreviewStatus = "disabled" | "booting" | "loading" | "ready" | "error" | "expired";

export interface PreviewVersion {
  id: string;
  versionNumber: number;
  status: "creating" | "ready" | "failed" | "delete_requested";
}

const statusLabels: Record<PreviewStatus, string> = {
  disabled: "Deshabilitada",
  booting: "Conectando",
  loading: "Cargando",
  ready: "Lista",
  error: "Error",
  expired: "Sesión vencida",
};

const statusColors: Record<PreviewStatus, "gray" | "orange" | "green" | "red"> = {
  disabled: "gray",
  booting: "orange",
  loading: "orange",
  ready: "green",
  error: "red",
  expired: "orange",
};

export function PreviewToolbar({
  status,
  enabled,
  openTabHref,
  versions,
  historyIndex,
  historyLength,
  onBack,
  onForward,
  onReload,
  selectedVersionId,
  onVersionSelect,
}: {
  status: PreviewStatus;
  enabled: boolean;
  openTabHref: string;
  versions: readonly PreviewVersion[];
  historyIndex: number;
  historyLength: number;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  selectedVersionId: string;
  onVersionSelect(versionId: string): void;
}) {
  const busy = status === "booting" || status === "loading";

  return (
    <div className={styles.toolbar}>
      <div className={styles.navigation} role="group" aria-label="Controles de vista previa">
        <Button variant="ghost" size="1" disabled={!enabled || busy || historyIndex <= 0} onClick={onBack} aria-label="Volver en la vista previa">←</Button>
        <Button variant="ghost" size="1" disabled={!enabled || busy || historyIndex >= historyLength - 1} onClick={onForward} aria-label="Avanzar en la vista previa">→</Button>
        <Button variant="ghost" size="1" disabled={!enabled || busy} onClick={onReload} aria-label="Recargar vista previa">↻</Button>
        {enabled ? (
          <a className={styles.openTab} href={openTabHref} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label="Abrir vista previa en otra pestaña">↗</a>
        ) : <Button variant="ghost" size="1" disabled aria-label="Abrir vista previa en otra pestaña">↗</Button>}
      </div>
      <div className={styles.toolbarRight}>
        <Select.Root value={selectedVersionId} disabled={versions.length === 0} onValueChange={onVersionSelect}>
          <Select.Trigger aria-label="Versión de la vista previa" />
          <Select.Content>
            <Select.Item value="latest">Latest · última verificada</Select.Item>
            {versions.map((version) => (
              <Select.Item key={version.id} value={version.id}>
                v{version.versionNumber} · {version.status === "ready" ? "verificada" : version.status}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <Badge color={statusColors[status]} variant="soft" aria-label={`Estado de la preview: ${statusLabels[status]}`}>
          {statusLabels[status]}
        </Badge>
      </div>
      {versions.length > 0 ? (
        <Text as="span" size="1" color="gray" className={styles.versionNote}>
          Elige una versión para revisar sus cambios y restaurarla como una versión nueva.
        </Text>
      ) : null}
    </div>
  );
}
