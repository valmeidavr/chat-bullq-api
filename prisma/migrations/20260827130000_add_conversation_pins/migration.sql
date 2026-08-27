-- CreateTable
CREATE TABLE "conversation_pins" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "pinned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_pins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_pins_user_id_idx" ON "conversation_pins"("user_id");

-- CreateIndex
CREATE INDEX "conversation_pins_conversation_id_idx" ON "conversation_pins"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_pins_user_id_conversation_id_key" ON "conversation_pins"("user_id", "conversation_id");

-- AddForeignKey
ALTER TABLE "conversation_pins" ADD CONSTRAINT "conversation_pins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_pins" ADD CONSTRAINT "conversation_pins_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
