-- Reversión manual de la clave UUID del ledger. Los IDs se regeneran como secuencia;
-- cualquier cursor externo antiguo deja de ser válido. Para conservar IDs, restaurar backup.
ALTER TABLE "usage_ledger" ADD COLUMN "legacy_id" bigserial;--> statement-breakpoint
ALTER TABLE "usage_ledger" DROP CONSTRAINT "usage_ledger_pkey";--> statement-breakpoint
ALTER TABLE "usage_ledger" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "usage_ledger" RENAME COLUMN "legacy_id" TO "id";--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_pkey" PRIMARY KEY("id");
