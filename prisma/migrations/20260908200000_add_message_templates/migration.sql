-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED');

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'pt_BR',
    "category" TEXT NOT NULL DEFAULT 'UTILITY',
    "body" TEXT NOT NULL,
    "variables_count" INTEGER NOT NULL DEFAULT 0,
    "buttons" JSONB,
    "provider" TEXT NOT NULL DEFAULT 'TWILIO',
    "provider_sid" TEXT,
    "approval_sid" TEXT,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_template_org" ON "message_templates"("organization_id");
CREATE INDEX "idx_template_org_status" ON "message_templates"("organization_id", "status");
