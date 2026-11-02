import { Badge, Card, Heading, Progress as RadixProgress, Text } from "@radix-ui/themes";
import type { ReactNode } from "react";
import styles from "./feedback.module.css";

type StateProps = {
  title: string;
  description: string;
  action?: ReactNode;
};

export function EmptyState({ title, description, action }: StateProps) {
  return (
    <Card className={styles.state} role="status" size="3">
      <Badge className={styles.badge} color="cyan" variant="soft">Sin contenido</Badge>
      <Heading as="h2" size="4" className={styles.title}>{title}</Heading>
      <Text as="p" color="gray">{description}</Text>
      {action ? <div className={styles.action}>{action}</div> : null}
    </Card>
  );
}

export function ErrorState({ title, description, action }: StateProps) {
  return (
    <Card className={styles.state} role="alert" size="3">
      <Badge className={styles.badge} color="red" variant="soft">No se pudo completar</Badge>
      <Heading as="h2" size="4" className={styles.title}>{title}</Heading>
      <Text as="p" color="gray">{description}</Text>
      {action ? <div className={styles.action}>{action}</div> : null}
    </Card>
  );
}

export function ProgressState({
  label,
  value,
  description,
}: {
  label: string;
  value: number;
  description?: string;
}) {
  const progress = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;

  return (
    <div className={styles.progress} role="status" aria-live="polite">
      <div className={styles.progressHeading}>
        <Text as="span" weight="medium">{label}</Text>
        <Text as="span" color="gray">{Math.round(progress)}%</Text>
      </div>
      <RadixProgress aria-label={label} value={progress} max={100} />
      {description ? <Text as="p" color="gray">{description}</Text> : null}
    </div>
  );
}
