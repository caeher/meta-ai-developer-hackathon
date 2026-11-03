"use client";

import Image from "next/image";
import { Badge, Button, Dialog, Heading, Text } from "@radix-ui/themes";
import type { AssetToolCard as AssetToolCardData } from "@meta-game/contracts";
import styles from "./EditorShell.module.css";

const assetTypeLabels: Record<AssetToolCardData["assetType"], string> = {
  sprite: "Sprite",
  background: "Fondo",
  ui: "Interfaz",
  tileset: "Tileset",
  tilemap: "Tilemap",
  spritesheet: "Spritesheet",
  animation: "Animación",
  inspection: "Inspección",
};

const verificationLabels: Record<AssetToolCardData["verificationStatus"], string> = {
  passed: "Verificado",
  needs_review: "Revisión visual pendiente",
  failed: "Verificación fallida",
  not_applicable: "Sin verificaciones",
};

export function AssetToolCard({ card, projectId }: { card: AssetToolCardData; projectId: string }) {
  const previewUrl = card.previewAssetId
    ? `/api/projects/${projectId}/assets/${card.previewAssetId}/preview`
    : undefined;

  return (
    <article className={styles.assetCard} aria-labelledby={`asset-card-title-${card.callId}`}>
      <header className={styles.assetCardHeader}>
        <div>
          <Heading as="h3" size="2" id={`asset-card-title-${card.callId}`}>{card.title}</Heading>
          <Text as="p" size="1" color="gray">{assetTypeLabels[card.assetType]}</Text>
        </div>
        <Badge color={card.status === "failed" ? "red" : "green"} variant="soft">
          {card.status === "failed" ? "Falló" : "Listo"}
        </Badge>
      </header>

      <Text as="p" size="2">{card.summary}</Text>

      {previewUrl ? (
        <Dialog.Root>
          <Dialog.Trigger>
            <Button variant="soft" className={styles.assetPreviewButton} aria-label={`Abrir preview privada de ${card.title}`}>
              <Image src={previewUrl} alt={`Preview privada: ${card.title}`} width={160} height={120} unoptimized className={styles.assetThumbnail} />
              <span>Abrir preview privada</span>
            </Button>
          </Dialog.Trigger>
          <Dialog.Content maxWidth="720px">
            <Dialog.Title>{card.title}</Dialog.Title>
            <Dialog.Description>{card.summary}. El asset se sirve con la sesión privada del proyecto.</Dialog.Description>
            <div className={styles.assetPreviewLarge}>
              <Image src={previewUrl} alt={`Asset ${assetTypeLabels[card.assetType]}`} width={1024} height={768} unoptimized />
            </div>
            <div className={styles.dialogActions}>
              <Dialog.Close><Button variant="soft">Cerrar preview</Button></Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Root>
      ) : null}

      {card.frameCount !== undefined || card.layerCount !== undefined ? (
        <p className={styles.assetDimensions}>
          {card.frameCount === undefined ? null : <span>{card.frameCount} {card.assetType === "tileset" ? "tiles" : "frames/celdas"}</span>}
          {card.layerCount === undefined ? null : <span>{card.layerCount} capas</span>}
        </p>
      ) : null}

      <div className={styles.assetVerification}>
        <Badge color={card.verificationStatus === "failed" ? "red" : card.verificationStatus === "needs_review" ? "orange" : "green"} variant="soft">
          {verificationLabels[card.verificationStatus]}
        </Badge>
        <Text as="p" size="1">{card.verificationSummary}</Text>
      </div>

      {card.errorCode ? <p className={styles.assetError}>Código: <code>{card.errorCode}</code></p> : null}

      {card.assets.length > 0 ? (
        <details className={styles.assetDetails}>
          <summary>IDs y hashes verificados</summary>
          <ul>
            {card.assets.map((asset) => (
              <li key={`${asset.assetId}-${asset.role}`}>
                <span>{asset.role}</span>
                <code>{asset.assetId}</code>
                {asset.sha256 ? <code>SHA-256 {asset.sha256}</code> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}
