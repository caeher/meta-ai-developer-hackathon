-- Mantiene filas existentes, reemplazando la secuencia interna por UUID opacos.
ALTER TABLE "usage_ledger" ADD COLUMN "id_uuid" uuid;--> statement-breakpoint
UPDATE "usage_ledger" SET "id_uuid" = gen_random_uuid();--> statement-breakpoint
ALTER TABLE "usage_ledger" ALTER COLUMN "id_uuid" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "usage_ledger" ALTER COLUMN "id_uuid" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" DROP CONSTRAINT "usage_ledger_pkey";--> statement-breakpoint
ALTER TABLE "usage_ledger" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "usage_ledger" RENAME COLUMN "id_uuid" TO "id";--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_pkey" PRIMARY KEY("id");
